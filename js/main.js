import { AudioEngine } from './audio-engine.js';
import { UIController } from './ui-controller.js';

document.addEventListener('DOMContentLoaded', () => {
    const audioEngine = new AudioEngine();
    const uiController = new UIController(audioEngine);

    // Initialize UI (listeners) immediately
    uiController.init();

    // Audio engine lazy loads on first user interaction (Power Button)
});
