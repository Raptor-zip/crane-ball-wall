import {loadFont} from '@remotion/google-fonts/MPLUSRounded1c';

// the game's own typeface (game/src/ui/tokens.css --font-head)
const f = loadFont('normal', {weights: ['500', '800', '900'], subsets: ['japanese', 'latin']});
export const FONT = f.fontFamily;
export const waitForFonts = () => f.waitUntilDone();
