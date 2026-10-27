<script lang="ts">
  // Official Tabler outline SVGs. See TABLER-LICENSE for provenance.
  let {
    name,
    size = 18,
  }: {
    name:
      | "arrow-up-right"
      | "arrow-up"
      | "check"
      | "chevron-down"
      | "chevron-right"
      | "circle-check"
      | "circle"
      | "command"
      | "dots"
      | "file-text"
      | "folder"
      | "history"
      | "layout-grid"
      | "layout-sidebar"
      | "link"
      | "message"
      | "paperclip"
      | "player-play"
      | "plus"
      | "search"
      | "settings"
      | "x";
    size?: number;
  } = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.65"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  {#if name === "arrow-up-right"}
    <path d="M17 7l-10 10" />
    <path d="M8 7l9 0l0 9" />
  {:else if name === "arrow-up"}
    <path d="M12 5l0 14" />
    <path d="M18 11l-6 -6" />
    <path d="M6 11l6 -6" />
  {:else if name === "check"}
    <path d="M5 12l5 5l10 -10" />
  {:else if name === "chevron-down"}
    <path d="M6 9l6 6l6 -6" />
  {:else if name === "chevron-right"}
    <path d="M9 6l6 6l-6 6" />
  {:else if name === "circle-check"}
    <path d="M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0" />
    <path d="M9 12l2 2l4 -4" />
  {:else if name === "circle"}
    <path d="M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0" />
  {:else if name === "command"}
    <path d="M7 9a2 2 0 1 1 2 -2v10a2 2 0 1 1 -2 -2h10a2 2 0 1 1 -2 2v-10a2 2 0 1 1 2 2h-10" />
  {:else if name === "dots"}
    <path d="M4 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" />
    <path d="M11 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" />
    <path d="M18 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" />
  {:else if name === "file-text"}
    <path d="M14 3v4a1 1 0 0 0 1 1h4" />
    <path d="M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2" />
    <path d="M9 9l1 0" />
    <path d="M9 13l6 0" />
    <path d="M9 17l6 0" />
  {:else if name === "folder"}
    <path d="M5 4h4l3 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2" />
  {:else if name === "history"}
    <path d="M12 8l0 4l2 2" />
    <path d="M3.05 11a9 9 0 1 1 .5 4m-.5 5v-5h5" />
  {:else if name === "layout-grid"}
    <path d="M4 5a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -4" />
    <path d="M14 5a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -4" />
    <path d="M4 15a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -4" />
    <path d="M14 15a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -4" />
  {:else if name === "layout-sidebar"}
    <path d="M4 6a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2l0 -12" />
    <path d="M9 4l0 16" />
  {:else if name === "link"}
    <path d="M9 15l6 -6" />
    <path d="M11 6l.463 -.536a5 5 0 0 1 7.071 7.072l-.534 .464" />
    <path d="M13 18l-.397 .534a5.068 5.068 0 0 1 -7.127 0a4.972 4.972 0 0 1 0 -7.071l.524 -.463" />
  {:else if name === "message"}
    <path d="M8 9h8" />
    <path d="M8 13h6" />
    <path
      d="M18 4a3 3 0 0 1 3 3v8a3 3 0 0 1 -3 3h-5l-5 3v-3h-2a3 3 0 0 1 -3 -3v-8a3 3 0 0 1 3 -3h12"
    />
  {:else if name === "paperclip"}
    <path
      d="M15 7l-6.5 6.5a1.5 1.5 0 0 0 3 3l6.5 -6.5a3 3 0 0 0 -6 -6l-6.5 6.5a4.5 4.5 0 0 0 9 9l6.5 -6.5"
    />
  {:else if name === "player-play"}
    <path d="M7 4v16l13 -8l-13 -8" />
  {:else if name === "plus"}
    <path d="M12 5l0 14" />
    <path d="M5 12l14 0" />
  {:else if name === "search"}
    <path d="M3 10a7 7 0 1 0 14 0a7 7 0 1 0 -14 0" />
    <path d="M21 21l-6 -6" />
  {:else if name === "settings"}
    <path
      d="M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065"
    />
    <path d="M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0" />
  {:else if name === "x"}
    <path d="M18 6l-12 12" />
    <path d="M6 6l12 12" />
  {/if}
</svg>
