/**
 * TextDecoder 的最小 polyfill。
 *
 * ## 为什么需要
 *
 * `mammoth`（docx 解析）内部用 `new TextDecoder(encoding)` 把
 * Word 文档里的 XML 字节转成字符串。这是 Node / 浏览器的 API，
 * 但 **Hermes 没有内置** —— 直接调用会报
 * `Property 'TextDecoder' doesn't exist`。
 *
 * ## 实现范围
 *
 * 只实现 docx 场景真正需要的：
 *   - `utf-8`（Word 的 XML 基本都是 UTF-8）
 *   - `utf-16le`（少数文档会用）
 *   - `latin1` / `windows-1252`（兜底成 latin1）
 *
 * 不做编码检测、不做流式 decode —— 用不上，实现越简单越不容易出错。
 *
 * 已经存在就不覆盖（未来 RN 版本可能自己带上）。
 */

type Label = string;

function decodeUtf8(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i];
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
      i += 1;
      continue;
    }
    // 续字节的数量
    let extra = 0;
    let cp = 0;
    if (b0 >= 0xc2 && b0 <= 0xdf) {
      extra = 1;
      cp = b0 & 0x1f;
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      extra = 2;
      cp = b0 & 0x0f;
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      extra = 3;
      cp = b0 & 0x07;
    } else {
      // 非法起始字节：用替换字符，别抛错（文档损坏也要能显示）
      out += '\uFFFD';
      i += 1;
      continue;
    }
    if (i + extra >= bytes.length) {
      out += '\uFFFD';
      break;
    }
    let ok = true;
    for (let k = 1; k <= extra; k += 1) {
      const bn = bytes[i + k];
      if ((bn & 0xc0) !== 0x80) {
        ok = false;
        break;
      }
      cp = (cp << 6) | (bn & 0x3f);
    }
    if (!ok) {
      out += '\uFFFD';
      i += 1;
      continue;
    }
    // 代理对
    if (cp > 0xffff) {
      const v = cp - 0x10000;
      out += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
    } else {
      out += String.fromCharCode(cp);
    }
    i += extra + 1;
  }
  return out;
}

function decodeLatin1(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) out += String.fromCharCode(bytes[i]);
  return out;
}

function decodeUtf16le(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    out += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8));
  }
  return out;
}

class SimpleTextDecoder {
  private readonly label: string;

  constructor(label?: Label) {
    this.label = (label ?? 'utf-8').toLowerCase();
    this.encoding = this.label;
    this.fatal = false;
    this.ignoreBOM = false;
  }

  readonly encoding: string;
  readonly fatal: boolean;
  readonly ignoreBOM: boolean;

  decode(input?: ArrayBuffer | ArrayBufferView): string {
    if (!input) return '';
    let bytes: Uint8Array;
    if (input instanceof Uint8Array) bytes = input;
    else if (ArrayBuffer.isView(input)) {
      bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    } else {
      bytes = new Uint8Array(input as ArrayBuffer);
    }

    if (this.label === 'utf-16le' || this.label === 'utf16le') return decodeUtf16le(bytes);
    if (this.label === 'latin1' || this.label === 'iso-8859-1' || this.label === 'windows-1252') {
      return decodeLatin1(bytes);
    }
    return decodeUtf8(bytes);
  }
}

/** 幂等地装上 polyfill */
export function installTextDecoderPolyfill(): void {
  const g = globalThis as Record<string, unknown>;
  if (typeof g.TextDecoder === 'undefined') {
    g.TextDecoder = SimpleTextDecoder;
  }
}
