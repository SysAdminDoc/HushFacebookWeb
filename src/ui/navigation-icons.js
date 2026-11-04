// Navigation icons from Tabler Icons, revision a4ce1404bc6d24d3c365afe7b258d6bf6f48d62d.
// https://github.com/tabler/tabler-icons
/*!
MIT License

Copyright (c) 2020-2026 Paweł Kuna

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

const shapes = {
  overview: [{"tag":"path","attrs":{"d":"M5 4h4a1 1 0 0 1 1 1v6a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1v-6a1 1 0 0 1 1 -1"}},{"tag":"path","attrs":{"d":"M5 16h4a1 1 0 0 1 1 1v2a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1v-2a1 1 0 0 1 1 -1"}},{"tag":"path","attrs":{"d":"M15 12h4a1 1 0 0 1 1 1v6a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1v-6a1 1 0 0 1 1 -1"}},{"tag":"path","attrs":{"d":"M15 4h4a1 1 0 0 1 1 1v2a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1v-2a1 1 0 0 1 1 -1"}}],
  ads: [{"tag":"path","attrs":{"d":"M9 5h10a2 2 0 0 1 2 2v10m-2 2h-14a2 2 0 0 1 -2 -2v-10a2 2 0 0 1 2 -2"}},{"tag":"path","attrs":{"d":"M7 15v-4a2 2 0 0 1 2 -2m2 2v4"}},{"tag":"path","attrs":{"d":"M7 13h4"}},{"tag":"path","attrs":{"d":"M17 9v4"}},{"tag":"path","attrs":{"d":"M16.115 12.131c.33 .149 .595 .412 .747 .74"}},{"tag":"path","attrs":{"d":"M3 3l18 18"}}],
  feed: [{"tag":"path","attrs":{"d":"M16 6h3a1 1 0 0 1 1 1v11a2 2 0 0 1 -4 0v-13a1 1 0 0 0 -1 -1h-10a1 1 0 0 0 -1 1v12a3 3 0 0 0 3 3h11"}},{"tag":"path","attrs":{"d":"M8 8l4 0"}},{"tag":"path","attrs":{"d":"M8 12l4 0"}},{"tag":"path","attrs":{"d":"M8 16l4 0"}}],
  video: [{"tag":"path","attrs":{"d":"M4 6a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2l0 -12"}},{"tag":"path","attrs":{"d":"M8 4l0 16"}},{"tag":"path","attrs":{"d":"M16 4l0 16"}},{"tag":"path","attrs":{"d":"M4 8l4 0"}},{"tag":"path","attrs":{"d":"M4 16l4 0"}},{"tag":"path","attrs":{"d":"M4 12l16 0"}},{"tag":"path","attrs":{"d":"M16 8l4 0"}},{"tag":"path","attrs":{"d":"M16 16l4 0"}}],
  comments: [{"tag":"path","attrs":{"d":"M8 9h8"}},{"tag":"path","attrs":{"d":"M8 13h6"}},{"tag":"path","attrs":{"d":"M18 4a3 3 0 0 1 3 3v8a3 3 0 0 1 -3 3h-5l-5 3v-3h-2a3 3 0 0 1 -3 -3v-8a3 3 0 0 1 3 -3h12"}}],
  privacy: [{"tag":"path","attrs":{"d":"M12 3a12 12 0 0 0 8.5 3a12 12 0 0 1 -8.5 15a12 12 0 0 1 -8.5 -15a12 12 0 0 0 8.5 -3"}},{"tag":"path","attrs":{"d":"M11 11a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"}},{"tag":"path","attrs":{"d":"M12 12l0 2.5"}}],
  downloads: [{"tag":"path","attrs":{"d":"M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2"}},{"tag":"path","attrs":{"d":"M7 11l5 5l5 -5"}},{"tag":"path","attrs":{"d":"M12 4l0 12"}}],
  appearance: [{"tag":"path","attrs":{"d":"M12 21a9 9 0 0 1 0 -18c4.97 0 9 3.582 9 8c0 1.06 -.474 2.078 -1.318 2.828c-.844 .75 -1.989 1.172 -3.182 1.172h-2.5a2 2 0 0 0 -1 3.75a1.3 1.3 0 0 1 -1 2.25"}},{"tag":"path","attrs":{"d":"M7.5 10.5a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"}},{"tag":"path","attrs":{"d":"M11.5 7.5a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"}},{"tag":"path","attrs":{"d":"M15.5 10.5a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"}}],
  more: [{"tag":"path","attrs":{"d":"M8 16l2 -6l6 -2l-2 6l-6 2"}},{"tag":"path","attrs":{"d":"M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0"}},{"tag":"path","attrs":{"d":"M12 3l0 2"}},{"tag":"path","attrs":{"d":"M12 19l0 2"}},{"tag":"path","attrs":{"d":"M3 12l2 0"}},{"tag":"path","attrs":{"d":"M19 12l2 0"}}],
  search: [{"tag":"path","attrs":{"d":"M3 10a7 7 0 1 0 14 0a7 7 0 1 0 -14 0"}},{"tag":"path","attrs":{"d":"M21 21l-6 -6"}}],
  general: [{"tag":"path","attrs":{"d":"M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065"}},{"tag":"path","attrs":{"d":"M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0"}}],
  diagnostics: [{"tag":"path","attrs":{"d":"M3 12h4l3 8l4 -16l3 8h4"}}],
  close: [{"tag":"path","attrs":{"d":"M18 6l-12 12"}},{"tag":"path","attrs":{"d":"M6 6l12 12"}}]
};

export function navigationIcon(id) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  for (const [key,value] of Object.entries({viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'1.75','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true',class:'nav-icon'})) svg.setAttribute(key,value);
  for (const shape of shapes[id] ?? shapes.general) {
    const child = document.createElementNS(ns, shape.tag);
    for (const [key,value] of Object.entries(shape.attrs)) child.setAttribute(key,value);
    svg.append(child);
  }
  return svg;
}
