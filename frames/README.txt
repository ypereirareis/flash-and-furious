Flash & Furious frames
======================

Drop frames here:
- PNG with transparency (the photo shows through the transparent areas), ideally 3:2 (e.g. 3000x2000);
- or a 3:2 SVG (viewBox 0 0 1500 1000). In an SVG, {{title}} and {{date}} are replaced
  with the frame text (set in /admin) and today's date (in the UI language).

The displayed name comes from the SVG <title> tag, otherwise from the file name. It can be
translated with a "frames.<file name without extension>" entry in public/locales/*.json.
Frames are sorted by file name (hence the 01-, 02-... prefix).
No restart needed: the list is read again every time the frame picker is opened.

Long text: add data-fit="WIDTH" (and optionally data-char-width="0.55") to the title <text> tag; the font
size is then reduced automatically so the text does not exceed that width (in viewBox units).
The {{title}} text is set on the /admin page (the same for every frame).
