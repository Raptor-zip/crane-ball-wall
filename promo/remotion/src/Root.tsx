import {Composition, staticFile} from 'remotion';
import {Promo, FPS, type Scene} from './Promo';
import {waitForFonts} from './fonts';

export const RemotionRoot = () => (
  <Composition
    id="Promo"
    component={Promo}
    fps={FPS}
    width={1080}
    height={1920}
    durationInFrames={30 * 28}
    defaultProps={{timeline: [] as Scene[]}}
    calculateMetadata={async () => {
      await waitForFonts();
      const timeline = (await (await fetch(staticFile('timeline.json'))).json()) as Scene[];
      const total = timeline.reduce((a, s) => a + s.duration, 0);
      return {props: {timeline}, durationInFrames: Math.round(total * FPS)};
    }}
  />
);
