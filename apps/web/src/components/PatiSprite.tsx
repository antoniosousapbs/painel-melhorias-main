/**
 * PATi Sprite Component
 * Uses individual PNG crops from /pati/ folder for each expression.
 * 19 expressions extracted from PATI.png spritesheet.
 */

type Expression =
  | 'amigavel' | 'feliz' | 'fofa' | 'piscando' | 'timida'
  | 'pensando' | 'confusa' | 'surpresa' | 'analisando' | 'ouvindo'
  | 'triste' | 'chorando' | 'irritada' | 'brava' | 'erro'
  | 'envergonhada' | 'chocada' | 'sonolenta' | 'dormindo';

interface PatiSpriteProps {
  expression?: Expression;
  size?: number;
  className?: string;
  title?: string;
}

export type { Expression };

import { getImagePath } from '../utils/imagePath';

export default function PatiSprite({ expression = 'amigavel', size = 40, className = '', title }: PatiSpriteProps) {
  return (
    <img
      src={getImagePath(`pati/${expression}.png`)}
      alt={`PATi ${expression}`}
      title={title}
      className={`inline-block flex-shrink-0 object-contain ${className}`}
      style={{ height: size, width: 'auto', imageRendering: 'auto' }}
      draggable={false}
    />
  );
}
