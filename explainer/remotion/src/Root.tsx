import React from 'react';
import {Composition, Still} from 'remotion';
import {Explainer, FPS, TOTAL_FRAMES} from './Explainer';
import {Thumbnail} from './Thumbnail';

export const RemotionRoot: React.FC = () => (
	<>
		<Composition id="Explainer" component={Explainer} durationInFrames={TOTAL_FRAMES} fps={FPS} width={1920} height={1080} />
		<Still id="Thumbnail" component={Thumbnail} width={1280} height={720} />
	</>
);
