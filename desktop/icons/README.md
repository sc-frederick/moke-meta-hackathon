# Application icon

The icon draws the brand M as walls in plan: a Bone outline over a hatched cut,
dimensioned above, on a Filament drafting grid. An Ember revision cloud, the
scalloped outline reviewers draw around a questioned detail, circles the right
foot as a finding. It follows Forge: flat Ink surface, hairline structure and
Ember as the single accent, placed where Forge's cover sets its Ember cursor.

| File                  | Use                                                             |
| --------------------- | --------------------------------------------------------------- |
| `icon.svg`            | Source on the macOS icon grid, with its shadow                  |
| `icon-full-bleed.svg` | Source filling the canvas, with heavier strokes for small icons |
| `icon.icns`           | macOS application and disk image icon, 16 through 1024 px       |
| `icon.png`            | 1024 px Linux icon and Linux window icon                        |
| `icon.ico`            | Windows executable and installer icon, 16 through 256 px        |

The ICNS file is prebuilt because Electron Builder's PNG-to-ICNS converter
hangs under Bun. Edit the SVG sources, then regenerate the raster files with
librsvg, ImageMagick and Bun:

```sh
rsvg-convert -w 1024 -h 1024 desktop/icons/icon.svg -o desktop/icons/icon.png
mkdir -p /tmp/moke-icns
for size in 16 32 64 128 256 512 1024; do
  rsvg-convert -w $size -h $size desktop/icons/icon.svg -o /tmp/moke-icns/$size.png
done
bun scripts/build-icns.ts /tmp/moke-icns desktop/icons/icon.icns
for size in 16 24 32 48 64 128 256; do
  rsvg-convert -w $size -h $size desktop/icons/icon-full-bleed.svg -o /tmp/moke-icon-$size.png
done
magick /tmp/moke-icon-{16,24,32,48,64,128,256}.png desktop/icons/icon.ico
```
