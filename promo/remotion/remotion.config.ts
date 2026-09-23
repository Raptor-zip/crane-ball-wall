import {Config} from '@remotion/cli/config';

// png frames: jpeg makes the encoder tag the video full-range (yuvj420p)
Config.setVideoImageFormat('png');
Config.setOverwriteOutput(true);
