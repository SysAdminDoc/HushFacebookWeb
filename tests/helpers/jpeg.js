// Small JPEG files built byte by byte, laid out the way Facebook serves its photos: segments
// before the scan, an APP13 Photoshop block holding IPTC, then a scan and the end of the image.

// Made up, in the shape Facebook uses: "FBMD" and a run of hex.
export const FACEBOOK_ID = 'FBMD0a000a1f0200001234567890abcdef0123456789abcdef';

export const ascii = (text) => [...text].map((char) => char.charCodeAt(0));
const bytesOf = (value) => (typeof value === 'string' ? ascii(value) : value);

export const segment = (code, body) => [0xff, code, (body.length + 2) >> 8, (body.length + 2) & 0xff, ...body];

// One IPTC dataset, in the short length form.
export function iptc(record, dataset, value) {
  const data = bytesOf(value);
  return [0x1c, record, dataset, data.length >> 8, data.length & 0xff, ...data];
}

// One Photoshop resource: "8BIM", its id, its name padded to an even count, its size, its data
// padded to an even count.
export function resource(id, data, name = '') {
  const label = [name.length, ...ascii(name)];
  if (label.length % 2) label.push(0);
  const size = data.length;
  return [...ascii('8BIM'), id >> 8, id & 0xff, ...label, size >>> 24, (size >> 16) & 0xff, (size >> 8) & 0xff, size & 0xff, ...data, ...(size % 2 ? [0] : [])];
}

export const photoshop = (...resources) => [...ascii('Photoshop 3.0\0'), ...resources.flat()];

// A start of scan, scan data with a stuffed 0xFF 0x00 and a restart marker in it, and the end.
export const SCAN = [0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0xff, 0xd9];

export const jpeg = (...segments) => Uint8Array.from([0xff, 0xd8, ...segments.flat(), ...SCAN]);
