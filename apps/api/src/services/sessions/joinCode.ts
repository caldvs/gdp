import { randomInt } from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const generateJoinCode = (): string => {
  let code = '';
  for (let i = 0; i < 6; i += 1) {
    code += ALPHABET[randomInt(ALPHABET.length)];
  }
  return code;
};

export const isJoinCode = (s: string): boolean => /^[A-HJ-NP-Z2-9]{6}$/.test(s);
