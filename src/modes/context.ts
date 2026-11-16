import * as THREE from 'three';
import { FoldStack } from '../core/fold';
import { CityStreamer } from '../city/streamer';
import { DreamAudio } from '../fx/audio';
import { Footfall } from '../fx/soundscape';
import { Picker } from '../fx/picking';
import { Hallway } from '../world/hallway';

/** What the interaction modes need from the app. */
export interface DreamContext {
  readonly canvas: HTMLCanvasElement;
  readonly camera: THREE.PerspectiveCamera;
  readonly folds: FoldStack;
  readonly streamer: CityStreamer;
  readonly picker: Picker;
  readonly audio: DreamAudio;
  readonly hallway: Hallway;
  readonly time: number;
  snap: boolean;
  /** A fold was finished by the user (for sound, instability and UI). */
  foldCommitted(strength: number): void;
  hint(text: string): void;
  /** What a footstep sounds like on the street at a fabric point, in the current dream. */
  footing(x: number, z: number): Footfall;
  kick(reason?: string): void;
}
