/** Standard base64 for small binary values (keys, IVs, ciphertexts). */
export const b64 = {
  encode(b: Uint8Array): string { let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s); },
  decode(s: string): Uint8Array<ArrayBuffer> { const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; },
};
