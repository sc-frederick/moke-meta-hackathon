<script lang="ts">
  import ReviewIcon from "./ReviewIcon.svelte";

  let {
    label,
    value,
    options,
    disabled = false,
    onChange,
  }: {
    label: string;
    value: string;
    options: ReadonlyArray<{
      value: string;
      label: string;
      description?: string;
      disabled?: boolean;
    }>;
    disabled?: boolean;
    onChange: (value: string) => void;
  } = $props();

  const id = $props.id();
  let trigger: HTMLButtonElement | undefined = $state();
  let menu: HTMLDivElement | undefined = $state();
  let open = $state(false);
  const selected = $derived(options.find((option) => option.value === value));

  function positionMenu() {
    if (!trigger || !menu) return;
    const anchor = trigger.getBoundingClientRect();
    const width = Math.min(Math.max(anchor.width, 240), window.innerWidth - 24);
    const height = Math.min(menu.scrollHeight, window.innerHeight - 24, 320);
    menu.style.width = `${width}px`;
    menu.style.left = `${Math.max(12, Math.min(anchor.left, window.innerWidth - width - 12))}px`;
    menu.style.top = `${Math.max(12, anchor.top >= height + 12 ? anchor.top - height - 6 : Math.min(anchor.bottom + 6, window.innerHeight - height - 12))}px`;
  }

  function close(returnFocus = true) {
    menu?.hidePopover();

    if (returnFocus) trigger?.focus();
  }

  function show() {
    menu?.showPopover();
    positionMenu();
    const current = menu?.querySelector<HTMLButtonElement>('[aria-selected="true"]:not(:disabled)');
    (current ?? menu?.querySelector<HTMLButtonElement>("button:not(:disabled)"))?.focus();
  }

  function navigate(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      close();

      return;
    }

    if (event.key === "Tab") {
      close(false);

      return;
    }

    const buttons = Array.from(
      menu?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [],
    );

    const index = buttons.findIndex((button) => button === document.activeElement);
    let next = index;

    if (event.key === "ArrowDown") next = (index + 1) % buttons.length;
    else if (event.key === "ArrowUp") next = (index - 1 + buttons.length) % buttons.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = buttons.length - 1;
    else return;
    event.preventDefault();
    buttons[next]?.focus();
  }
</script>

<svelte:window onresize={() => close(false)} />
<button
  class="picker"
  type="button"
  {disabled}
  aria-label={`${label}: ${selected?.label ?? "Choose…"}`}
  aria-haspopup="listbox"
  aria-expanded={open}
  aria-controls={id}
  bind:this={trigger}
  popovertarget={id}
  onclick={(event) => {
    event.preventDefault();
    if (menu?.matches(":popover-open")) close();
    else show();
  }}
  onkeydown={(event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      show();
    }
  }}
  ><span class="picker-label">{label}</span><span class="picker-value"
    >{selected?.label ?? "Choose…"}</span
  ><ReviewIcon name="chevron-down" size={13} /></button
>
<div
  {id}
  class="options"
  popover="auto"
  role="listbox"
  aria-label={label}
  tabindex="-1"
  bind:this={menu}
  ontoggle={(event) => {
    open = event.newState === "open";
  }}
  onkeydown={navigate}
>
  {#each options as option (option.value)}
    <button
      type="button"
      role="option"
      aria-selected={value === option.value}
      disabled={option.disabled}
      onclick={() => {
        onChange(option.value);
        close();
      }}
      ><span
        ><strong>{option.label}</strong>{#if option.description}<small>{option.description}</small
          >{/if}</span
      >{#if value === option.value}<ReviewIcon name="check" size={15} />{/if}</button
    >
  {/each}
</div>

<style>
  .picker {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
    max-width: 100%;
    border: 0;
    background: transparent;
    color: var(--nd-ink);
    font: inherit;
    font-size: 12px;
    padding: 7px 8px;
    border-radius: 7px;
    cursor: pointer;
  }
  .picker:hover {
    background: var(--nd-raised-hover);
  }
  .picker-label {
    color: var(--nd-ink-muted);
  }
  .picker-value {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .options {
    position: fixed;
    margin: 0;
    padding: 5px;
    max-height: min(320px, calc(100dvh - 24px));
    overflow-y: auto;
    border: 1px solid var(--nd-hairline-strong);
    border-radius: 10px;
    background: var(--nd-panel);
    color: var(--nd-ink);
    box-shadow: 0 12px 32px rgb(0 0 0 / 0.24);
  }
  .options button {
    width: 100%;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    border: 0;
    border-radius: 6px;
    text-align: left;
    background: transparent;
    color: inherit;
    padding: 9px 10px;
    font: inherit;
    cursor: pointer;
  }
  .options button:hover,
  .options button:focus-visible {
    background: var(--nd-raised-hover);
  }
  strong {
    font-size: 13px;
    font-weight: 500;
  }
  small {
    display: block;
    font-size: 11px;
    color: var(--nd-ink-muted);
    margin-top: 3px;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  button:focus-visible {
    outline: 2px solid var(--nd-ink-muted);
    outline-offset: 2px;
  }
</style>
