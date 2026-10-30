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
    const width = Math.min(Math.max(anchor.width, 300), window.innerWidth - 24);
    const height = Math.min(menu.scrollHeight, window.innerHeight - 24, 320);
    menu.style.width = `${width}px`;
    menu.style.left = `${Math.max(12, Math.min(anchor.left, window.innerWidth - width - 12))}px`;
    menu.style.top = `${Math.max(12, anchor.top >= height + 12 ? anchor.top - height - 6 : Math.min(anchor.bottom + 6, window.innerHeight - height - 12))}px`;
  }

  function close(returnFocus = true) {
    menu?.hidePopover();

    if (returnFocus) trigger?.focus();
  }

  function show(keyboard = true) {
    menu?.showPopover();
    positionMenu();
    const current = menu?.querySelector<HTMLButtonElement>('[aria-selected="true"]:not(:disabled)');

    if (keyboard)
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
    else show(event.detail === 0);
  }}
  onkeydown={(event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      show();
    }
  }}
  ><span class="picker-label">{label}</span><span class="picker-value"
    >{selected?.label ?? "Choose…"}</span
  ><ReviewIcon name="chevron-down" size={14} /></button
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
      >{#if value === option.value}<ReviewIcon name="check" size={16} />{/if}</button
    >
  {/each}
</div>

<style>
  .picker {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    max-width: 100%;
    height: 28px;
    border: 1px solid transparent;
    background: transparent;
    color: var(--color-text);
    font-size: var(--text-body-sm);
    padding: 0 var(--space-xs);
    border-radius: var(--radius-md);
    transition:
      background var(--duration-fast) var(--ease-out),
      border-color var(--duration-fast) var(--ease-out);
  }
  .picker:hover:not(:disabled),
  .picker[aria-expanded="true"] {
    background: var(--color-slate);
  }
  .picker[aria-expanded="true"] {
    border-color: var(--color-border-strong);
  }
  .picker :global(svg) {
    color: var(--color-text-muted);
  }
  .picker-label {
    color: var(--color-text-muted);
    font-family: var(--font-mono);
    font-size: var(--text-label-sm);
    font-weight: 500;
    letter-spacing: var(--tracking-wider);
    text-transform: uppercase;
  }
  .picker-value {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 500;
  }
  .options {
    position: fixed;
    margin: 0;
    padding: var(--space-2xs);
    max-height: min(320px, calc(100dvh - 24px));
    overflow-y: auto;
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-lg);
    background: var(--color-surface);
    color: var(--color-text);
    box-shadow: var(--shadow-pop);
  }
  .options button {
    width: 100%;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-sm);
    min-height: 36px;
    border: 0;
    border-radius: var(--radius-md);
    text-align: left;
    background: transparent;
    color: inherit;
    padding: 6px 10px;
  }
  .options button:hover:not(:disabled),
  .options button:focus-visible {
    background: var(--color-slate);
    box-shadow: none;
  }
  .options button:focus-visible {
    box-shadow: inset 2px 0 0 var(--color-ember);
  }
  .options button[aria-selected="true"] {
    color: var(--color-text);
  }
  .options button[aria-selected="true"] :global(svg) {
    color: var(--color-ember);
  }
  strong {
    font-size: var(--text-body-sm);
    font-weight: 500;
  }
  small {
    display: block;
    font-size: var(--text-mono-sm);
    color: var(--color-text-muted);
    margin-top: 2px;
  }
</style>
