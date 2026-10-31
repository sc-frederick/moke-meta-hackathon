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
| `icon.png`            | 1024 px macOS and Linux icon, and the Linux window icon         |
| `icon.ico`            | Windows executable and installer icon, 16 through 256 px        |

Edit the SVG sources, then regenerate the raster files with librsvg and
ImageMagick:

```sh
rsvg-convert -w 1024 -h 1024 desktop/icons/icon.svg -o desktop/icons/icon.png
for size in 16 24 32 48 64 128 256; do
  rsvg-convert -w $size -h $size desktop/icons/icon-full-bleed.svg -o /tmp/moke-icon-$size.png
done
magick /tmp/moke-icon-{16,24,32,48,64,128,256}.png desktop/icons/icon.ico
```
