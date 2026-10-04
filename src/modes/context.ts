import * as THREE from 'three';
import { FoldStack } from '../core/fold';
import { CityStreamer } from '../city/streamer';
import { DreamAudio } from '../fx/audio';
import { Picker } from '../fx/picking';

/** What the interaction modes need from the app. */
export interface DreamContext {
  readonly canvas: HTMLCanvasElement;
  readonly camera: THREE.PerspectiveCamera;
  readonly folds: FoldStack;
  readonly streamer: CityStreamer;
  readonly picker: Picker;
  readonly audio: DreamAudio;
  readonly time: number;
  snap: boolean;
  /** A fold was finished by the user (for sound, instability and UI). */
  foldCommitted(strength: number): void;
  hint(text: string): void;
  kick(reason?: string): void;
}
