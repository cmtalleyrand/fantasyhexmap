/**
 * Lettering: which typefaces a map's names are set in.
 *
 * A pairing gives each kind of name its face: realms (spaced capitals), water
 * (italic seas, lakes and rivers) and cities. The bundled faces are open-licence
 * fonts shipped with the app (see `fontFiles.ts`, which loads them in the
 * browser and embeds them in SVG exports); this module only names them, so the
 * scene builder stays pure and runs under node.
 */

import { FANTASY_FONT_STACK, FONT_STACK } from './fonts.js';

export type LetteringId = 'classic' | 'storybook' | 'oldprint' | 'chancery' | 'uncial';

export interface FaceRole {
  /** CSS font-family list, the bundled face first. */
  family: string;
  weight: number;
  italic: boolean;
  /** Letter-spacing in em. */
  tracking: number;
  /** Size relative to the default, so faces with short lower case read at the same size. */
  scale?: number;
}

export interface Lettering {
  id: LetteringId;
  realm: FaceRole;
  /** Seas and lakes. */
  water: FaceRole;
  /** Rivers: the water face, more tightly spaced. */
  river: FaceRole;
  city: FaceRole;
  /** Mountain range names. */
  range: FaceRole;
}

/** A bundled face: the family name it is registered under, and which file. */
export interface BundledFace {
  family: string;
  weight: number;
  italic: boolean;
  /** Key into the file table in `fontFiles.ts`. */
  file: string;
}

const serif = 'Georgia, "Times New Roman", serif';
const fam = (name: string, fallback: string) => `"${name}", ${fallback}`;

export const LETTERINGS: Record<LetteringId, Lettering> = {
  classic: {
    id: 'classic',
    realm: { family: FANTASY_FONT_STACK, weight: 600, italic: false, tracking: 0 },
    water: { family: FANTASY_FONT_STACK, weight: 500, italic: true, tracking: 0.32 },
    river: { family: FANTASY_FONT_STACK, weight: 600, italic: true, tracking: 0.08 },
    city: { family: FONT_STACK, weight: 600, italic: false, tracking: 0 },
    range: { family: FANTASY_FONT_STACK, weight: 700, italic: false, tracking: 0 },
  },
  storybook: {
    id: 'storybook',
    realm: { family: fam('HexMap Cinzel', serif), weight: 600, italic: false, tracking: 0.12 },
    water: { family: fam('HexMap EB Garamond', serif), weight: 500, italic: true, tracking: 0.3 },
    river: { family: fam('HexMap EB Garamond', serif), weight: 500, italic: true, tracking: 0.06 },
    city: { family: fam('HexMap EB Garamond', serif), weight: 600, italic: false, tracking: 0, scale: 1.2 },
    range: { family: fam('HexMap Cinzel', serif), weight: 500, italic: false, tracking: 0.2 },
  },
  oldprint: {
    id: 'oldprint',
    realm: { family: fam('HexMap IM Fell English SC', serif), weight: 400, italic: false, tracking: 0.1 },
    water: { family: fam('HexMap IM Fell English', serif), weight: 400, italic: true, tracking: 0.28 },
    river: { family: fam('HexMap IM Fell English', serif), weight: 400, italic: true, tracking: 0.05 },
    city: { family: fam('HexMap IM Fell English', serif), weight: 400, italic: false, tracking: 0, scale: 1.15 },
    range: { family: fam('HexMap IM Fell English SC', serif), weight: 400, italic: false, tracking: 0.18 },
  },
  chancery: {
    id: 'chancery',
    realm: { family: fam('HexMap Almendra SC', serif), weight: 400, italic: false, tracking: 0.1 },
    water: { family: fam('HexMap Almendra', serif), weight: 400, italic: true, tracking: 0.26 },
    river: { family: fam('HexMap Almendra', serif), weight: 400, italic: true, tracking: 0.05 },
    city: { family: fam('HexMap Almendra', serif), weight: 400, italic: false, tracking: 0, scale: 1.12 },
    range: { family: fam('HexMap Almendra SC', serif), weight: 400, italic: false, tracking: 0.18 },
  },
  uncial: {
    id: 'uncial',
    realm: { family: fam('HexMap Uncial Antiqua', serif), weight: 400, italic: false, tracking: 0.06 },
    water: { family: fam('HexMap EB Garamond', serif), weight: 500, italic: true, tracking: 0.3 },
    river: { family: fam('HexMap EB Garamond', serif), weight: 500, italic: true, tracking: 0.06 },
    city: { family: fam('HexMap EB Garamond', serif), weight: 600, italic: false, tracking: 0, scale: 1.2 },
    range: { family: fam('HexMap Uncial Antiqua', serif), weight: 400, italic: false, tracking: 0.12 },
  },
};

export const LETTERING_ORDER: LetteringId[] = ['classic', 'storybook', 'oldprint', 'chancery', 'uncial'];

/** Every bundled face, and the families each pairing needs. */
export const BUNDLED_FACES: BundledFace[] = [
  { family: 'HexMap Cinzel', weight: 500, italic: false, file: 'cinzel-500' },
  { family: 'HexMap Cinzel', weight: 600, italic: false, file: 'cinzel-600' },
  { family: 'HexMap EB Garamond', weight: 500, italic: false, file: 'ebgaramond-500' },
  { family: 'HexMap EB Garamond', weight: 600, italic: false, file: 'ebgaramond-600' },
  { family: 'HexMap EB Garamond', weight: 500, italic: true, file: 'ebgaramond-500i' },
  { family: 'HexMap IM Fell English', weight: 400, italic: false, file: 'imfell-400' },
  { family: 'HexMap IM Fell English', weight: 400, italic: true, file: 'imfell-400i' },
  { family: 'HexMap IM Fell English SC', weight: 400, italic: false, file: 'imfellsc-400' },
  { family: 'HexMap Almendra', weight: 400, italic: false, file: 'almendra-400' },
  { family: 'HexMap Almendra', weight: 400, italic: true, file: 'almendra-400i' },
  { family: 'HexMap Almendra SC', weight: 400, italic: false, file: 'almendrasc-400' },
  { family: 'HexMap Uncial Antiqua', weight: 400, italic: false, file: 'uncial-400' },
];

/** The bundled faces a text set in `family` at this weight and slant would use. */
export function facesFor(family: string): BundledFace[] {
  return BUNDLED_FACES.filter((f) => family.startsWith(`"${f.family}"`));
}

export function letteringFaces(id: LetteringId): BundledFace[] {
  const l = LETTERINGS[id];
  const roles = [l.realm, l.water, l.river, l.city, l.range];
  return BUNDLED_FACES.filter((f) =>
    roles.some((r) => r.family.startsWith(`"${f.family}"`) && r.weight === f.weight && r.italic === f.italic),
  );
}
