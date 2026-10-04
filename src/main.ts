import './ui/styles.css';
import { App } from './app';

function supportsWebGL2(): boolean {
  try {
    return !!document.createElement('canvas').getContext('webgl2');
  } catch {
    return false;
  }
}

if (supportsWebGL2()) {
  (window as unknown as { dream: App }).dream = new App();
} else {
  document.getElementById('intro')!.innerHTML =
    '<div class="card"><h2>This dream needs WebGL2</h2><p>Try a current version of Chrome, Edge, Firefox or Safari.</p></div>';
}
