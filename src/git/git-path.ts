/** Decode Git's quoted pathname form used by non-NUL patch output. */
export function decodeGitPath(value: string): string {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) {
    return value;
  }

  const input = value.slice(1, -1);
  let output = "";
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (character !== "\\") {
      output += character;
      continue;
    }

    const escaped = input[index + 1];
    if (escaped === undefined) {
      output += "\\";
      continue;
    }
    const simple: Record<string, string> = {
      a: "\u0007",
      b: "\b",
      t: "\t",
      n: "\n",
      v: "\u000b",
      f: "\f",
      r: "\r",
      "\\": "\\",
      '"': '"',
    };
    const simpleValue = simple[escaped];
    if (simpleValue !== undefined) {
      output += simpleValue;
      index += 1;
      continue;
    }

    if (/^[0-7]$/.test(escaped)) {
      const octal = input.slice(index + 1, index + 4);
      if (/^[0-7]{1,3}$/.test(octal)) {
        output += String.fromCharCode(Number.parseInt(octal, 8));
        index += octal.length;
        continue;
      }
    }

    output += escaped;
    index += 1;
  }
  return output;
}
