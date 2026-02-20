// --- Audio Engine ---
class AudioEngine {
    constructor() {
        this.ctx = null;
        this.nodes = {};
        this.isInitialized = false;
        this.currentAmp = 'fender_clean'; // Default

        // State for switches to logic mapping
        this.state = {
            bright: false,
            drive: false
        };
    }

    async init() {
        if (this.isInitialized) return;

        this.ctx = new (window.AudioContext || window.webkitAudioContext)();

        // --- Create Nodes ---

        // 1. Input Source
        this.nodes.source = null;

        // 2. Noise Gate
        this.nodes.gate = this.ctx.createDynamicsCompressor();
        this.nodes.gate.threshold.value = -60;
        this.nodes.gate.ratio.value = 12;
        this.nodes.gate.attack.value = 0;
        this.nodes.gate.release.value = 0.25;

        // 3. Bright Switch (High Shelf Boost at input)
        this.nodes.bright = this.ctx.createBiquadFilter();
        this.nodes.bright.type = 'highshelf';
        this.nodes.bright.frequency.value = 4000;
        this.nodes.bright.gain.value = 0; // Starts off

        // 4. Compressor (Pedal style)
        this.nodes.compressor = this.ctx.createDynamicsCompressor();
        this.nodes.compressor.threshold.value = -30;
        this.nodes.compressor.ratio.value = 1; // Starts off (1:1)
        this.nodes.compressor.attack.value = 0.01;
        this.nodes.compressor.release.value = 0.1;

        // 5. Pre-Amp Gain
        this.nodes.preGain = this.ctx.createGain();
        this.nodes.preGain.gain.value = 3.0;

        // 6. Voice (Mid shaping before drive)
        this.nodes.voice = this.ctx.createBiquadFilter();
        this.nodes.voice.type = 'peaking';
        this.nodes.voice.frequency.value = 800;
        this.nodes.voice.Q.value = 1.0;
        this.nodes.voice.gain.value = 0;

        // 7. Distortion Stage
        this.nodes.distortion = this.ctx.createWaveShaper();
        this.nodes.distortion.curve = this.makeDistortionCurve(0);
        this.nodes.distortion.oversample = '4x';

        // 8. Tone Stack (Bass, Mid, Treble) - Passive stylization
        this.nodes.bass = this.ctx.createBiquadFilter();
        this.nodes.bass.type = 'lowshelf';
        this.nodes.bass.frequency.value = 250;

        this.nodes.mid = this.ctx.createBiquadFilter();
        this.nodes.mid.type = 'peaking';
        this.nodes.mid.frequency.value = 500;
        this.nodes.mid.Q.value = 1.0;

        this.nodes.treble = this.ctx.createBiquadFilter();
        this.nodes.treble.type = 'highshelf';
        this.nodes.treble.frequency.value = 2500;

        // 9. Presence (High freq emphasis in power amp)
        this.nodes.presence = this.ctx.createBiquadFilter();
        this.nodes.presence.type = 'peaking';
        this.nodes.presence.frequency.value = 3000; // Presence range
        this.nodes.presence.Q.value = 0.7;
        this.nodes.presence.gain.value = 0;

        // 10. Cabinet (IR)
        this.nodes.cab = this.ctx.createConvolver();
        await this.setInternalCab('fender_clean'); // Default load

        // 11. Master Volume
        this.nodes.master = this.ctx.createGain();
        this.nodes.master.gain.value = 1.0;

        // 12. Analyser
        this.nodes.analyser = this.ctx.createAnalyser();
        this.nodes.analyser.fftSize = 256;
        this.nodes.analyser.smoothingTimeConstant = 0.5;

        // --- Connect Graph ---
        // (Source -> Gate)
        this.nodes.gate.connect(this.nodes.bright);
        this.nodes.bright.connect(this.nodes.compressor);
        this.nodes.compressor.connect(this.nodes.preGain);
        this.nodes.preGain.connect(this.nodes.voice);
        this.nodes.voice.connect(this.nodes.distortion);
        this.nodes.distortion.connect(this.nodes.bass);
        this.nodes.bass.connect(this.nodes.mid);
        this.nodes.mid.connect(this.nodes.treble);
        this.nodes.treble.connect(this.nodes.presence);
        this.nodes.presence.connect(this.nodes.cab);
        this.nodes.cab.connect(this.nodes.master);
        this.nodes.master.connect(this.nodes.analyser);
        this.nodes.analyser.connect(this.ctx.destination);

        this.isInitialized = true;

        // Apply initial defaults again to be safe
        this.setAmpModel('fender');
        console.log("Audio Engine Initialized");
    }

    async startInput() {
        if (!this.ctx) await this.init();

        try {
            await this.ctx.resume();
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: false,
                    autoGainControl: false,
                    noiseSuppression: false,
                    latency: 0
                }
            });

            if (this.nodes.source) {
                this.nodes.source.disconnect();
            }

            this.nodes.source = this.ctx.createMediaStreamSource(stream);
            this.nodes.source.connect(this.nodes.gate);

            return true;
        } catch (err) {
            console.error("Error accessing microphone:", err);
            return false;
        }
    }

    togglePower() {
        if (!this.ctx) return false;
        if (this.ctx.state === 'suspended') {
            this.ctx.resume();
            return true;
        } else if (this.ctx.state === 'running') {
            this.ctx.suspend();
            return false;
        }
        return false;
    }

    // --- Params ---

    setParam(param, value) {
        if (!this.isInitialized) return;

        // Value normalization (optional, depends on usage)
        switch (param) {
            case 'gate':
                this.nodes.gate.threshold.value = value;
                break;
            case 'compressor':
                // Single knob controls Ratio and Threshold for simple operation
                // Value 0-1
                // Ratio 1:1 -> 12:1
                // Threshold -30 -> -50
                const ratio = 1 + (value * 11);
                const thresh = -30 - (value * 20);
                this.nodes.compressor.ratio.value = ratio;
                this.nodes.compressor.threshold.value = thresh;
                break;
            case 'preGain':
                // Base gain * multiplier if drive is on
                const multiplier = this.state.drive ? 3.0 : 1.0;
                this.nodes.preGain.gain.value = value * multiplier;
                break;
            case 'voice':
                this.nodes.voice.gain.value = value * 2; // -5 to 5 -> -10dB to 10dB
                break;
            case 'bass':
                this.nodes.bass.gain.value = value; // -10 to 10 typical
                break;
            case 'mid':
                this.nodes.mid.gain.value = value;
                break;
            case 'treble':
                this.nodes.treble.gain.value = value;
                break;
            case 'presence':
                this.nodes.presence.gain.value = value; // 0-10 -> 0-10dB
                break;
            case 'master':
                this.nodes.master.gain.value = value * 0.2; // Scaling down for safety
                break;
        }
    }

    toggleSwitch(switchName, isActive) {
        if (!this.isInitialized) return;

        if (switchName === 'bright') {
            this.nodes.bright.gain.value = isActive ? 6 : 0; // +6dB High Shelf
        } else if (switchName === 'drive') {
            this.state.drive = isActive;
            // Re-apply gain to update with multiplier
            // We need to read current knob value... effectively we need UI to send it or store it.
            // For now, simpler: we just modify the gain node relative to current or assume UI triggers a gain update too.
            // Actually, best way: let UI handle the value re-send, or just double current value.
            // Safe approach: The UI usually resends knob value on load, but here we just toggle multiplier.
            // We'll read the current gain and adjust.
            const currentBase = this.nodes.preGain.gain.value / (isActive ? 1.0 / 3.0 : 3.0); // reverse calc? messy.
            // Let's rely on the fact that changing the character changes distortion curve too potentially.
            // Simpler: Just boost the distortion curve intensity?
            // Let's just update the distortion curve for "Drive" mode.
            this.updateDistortion();
        }
    }

    async setAmpModel(model) {
        this.currentAmp = model;
        this.updateDistortion();
        await this.setInternalCab(model);
    }

    updateDistortion() {
        let baseAmount = 10;
        if (this.currentAmp.startsWith('marshall')) baseAmount = 60;
        if (this.currentAmp.startsWith('vox')) baseAmount = 35;

        if (this.state.drive) baseAmount *= 2.5;
        this.nodes.distortion.curve = this.makeDistortionCurve(baseAmount);
    }

    async loadInternalIR(filename) {
        try {
            const response = await fetch(`assets/irs/${filename}`);
            if (!response.ok) throw new Error("File not found");
            const arrayBuffer = await response.arrayBuffer();
            const buffer = await this.ctx.decodeAudioData(arrayBuffer);
            this.nodes.cab.buffer = buffer;
            console.log(`Loaded Pro IR: ${filename}`);
        } catch (e) {
            console.error(`Failed to load IR: ${filename}`, e);
            this.setSyntheticCab('fender');
        }
    }

    async setInternalCab(model) {
        if (model === 'fender_clean') {
            await this.loadInternalIR('fender_deluxe_big.wav');
        } else if (model === 'vox_chime') {
            await this.loadInternalIR('vox_ac30_blue.wav');
        } else if (model === 'marshall_drive') {
            await this.loadInternalIR('marshall_412_v30.wav');
        } else {
            console.warn("Model not found, falling back to fender_clean");
            await this.loadInternalIR('fender_deluxe_big.wav');
        }
    }

    async loadIR(arrayBuffer) {
        if (!this.ctx) return;
        try {
            const buffer = await this.ctx.decodeAudioData(arrayBuffer);
            this.nodes.cab.buffer = buffer;
            console.log("Custom IR Loaded");
            return true;
        } catch (e) {
            console.error("Failed to decode IR", e);
            return false;
        }
    }

    setSyntheticCab(model) {
        const duration = 0.5;
        const rate = this.ctx.sampleRate;
        const length = rate * duration;
        const impulse = this.ctx.createBuffer(2, length, rate);
        const left = impulse.getChannelData(0);
        const right = impulse.getChannelData(1);

        for (let i = 0; i < length; i++) {
            let val = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 4);

            if (model.includes('fender')) {
                if (i % 2 === 0) val *= 0.8;
            } else if (model.includes('marshall')) {
                if (i > 2) val = (val + left[i - 1] * 0.5) / 1.5;
            } else if (model.includes('vox')) {
                val *= (0.7 + Math.sin(i * 0.01) * 0.1);
            } else if (model === 'modern') {
                if (i % 4 === 0) val *= 1.2;
                if (i % 3 === 0) val *= 0.6;
            } else if (model === 'vintage') {
                if (i > 1) val = (val + left[i - 1]) / 2.2;
            } else if (model === 'boutique') {
                val *= (0.9 + Math.cos(i * 0.05) * 0.2);
            }

            left[i] = val;
            right[i] = val;
        }
        this.nodes.cab.buffer = impulse;
    }

    makeDistortionCurve(amount) {
        const n_samples = 44100;
        const curve = new Float32Array(n_samples);
        const deg = Math.PI / 180;
        for (let i = 0; i < n_samples; ++i) {
            const x = i * 2 / n_samples - 1;
            curve[i] = (3 + amount) * x * 20 * deg / (Math.PI + amount * Math.abs(x));
        }
        return curve;
    }

    getAnalyserData(array) {
        if (this.nodes.analyser) {
            this.nodes.analyser.getByteFrequencyData(array);
        }
    }
}

// --- UI Controller ---
class UIController {
    constructor(audioEngine) {
        this.audio = audioEngine;
        this.powerBtn = document.getElementById('power-btn');
        this.ampHead = document.querySelector('.amp-head-unit');

        // Modals
        this.welcomeModal = document.getElementById('welcome-modal');
        this.startBtn = document.getElementById('start-btn');
        this.settingsModal = document.getElementById('settings-modal');
        this.settingsBtn = document.getElementById('settings-btn');
        this.closeSettingsBtn = document.getElementById('close-settings-btn');

        // Custom Dropdown
        this.customSelect = document.querySelector('.custom-select');
        this.customSelectTrigger = document.querySelector('.custom-select__trigger');
        this.customOptions = document.querySelectorAll('.custom-option');
        this.selectedAmpName = document.getElementById('selected-amp-name');

        // Controls
        this.knobs = document.querySelectorAll('.knob');
        this.switches = document.querySelectorAll('.switch-wrapper input[type="checkbox"]');

        // IR Loader
        this.irUpload = document.getElementById('ir-upload');
        this.cabNameDisplay = document.getElementById('cab-name');

        this.vuOut = document.getElementById('vu-out');

        this.isDragging = false;
        this.currentKnob = null;
        this.startY = 0;
        this.startValue = 0;

        this.rafId = null;
    }

    init() {
        this.setupEventListeners();
        this.setupKnobInteractions();
        this.startVisualizer();
        console.log("UI Controller Initialized");
    }

    setupEventListeners() {
        // --- Welcome Screen / Audio Init ---
        if (this.startBtn) {
            this.startBtn.addEventListener('click', async () => {
                console.log("Start button clicked");

                // --- 1. IMMEDIATE DISMISSAL ---
                this.welcomeModal.classList.remove('active');

                // --- 2. AUDIO INIT ---
                try {
                    await this.audio.init();
                    console.log("Audio Engine Initialized");

                    // Start input asynchronously so it doesn't block UI if permission prompt hangs
                    this.audio.startInput().then(() => {
                        console.log("Audio Input Started");
                        // Auto power on for effect
                        this.audio.togglePower();
                        this.powerBtn.classList.add('active');
                        this.ampHead.classList.add('powered-on');
                    }).catch(e => {
                        console.error("Audio Input failed:", e);
                        // Still power on the UI for visual feedback even if input fails
                        // But maybe show a "No Input" toast?
                        this.powerBtn.classList.add('active');
                        this.ampHead.classList.add('powered-on');
                    });
                } catch (e) {
                    console.error("Audio initialization failed:", e);
                    // Ideally, show an error message on the UI somewhere
                    alert("Audio init failed: " + e.message + ". Continuing in offline mode.");
                }
            });
        }

        // --- Settings Modal ---
        if (this.settingsBtn) {
            this.settingsBtn.addEventListener('click', () => {
                this.settingsModal.classList.add('active');
            });
        }
        if (this.closeSettingsBtn) {
            this.closeSettingsBtn.addEventListener('click', () => {
                this.settingsModal.classList.remove('active');
            });
        }

        // --- Power Button ---
        this.powerBtn.addEventListener('click', async () => {
            // Fallback if not init (though welcome screen should handle it)
            if (!this.audio.isInitialized) await this.audio.init();

            const isRunning = await this.audio.togglePower();
            if (isRunning) {
                this.powerBtn.classList.add('active');
                this.ampHead.classList.add('powered-on');
                // Ensure input is running
                if (!this.audio.nodes.source) await this.audio.startInput();
            } else {
                this.powerBtn.classList.remove('active');
                this.ampHead.classList.remove('powered-on');
            }
        });

        // --- Custom Dropdown Logic ---
        if (this.customSelectTrigger) {
            this.customSelectTrigger.addEventListener('click', () => {
                this.customSelect.classList.toggle('open');
            });
        }

        // Close dropdown when clicking outside
        document.addEventListener('click', (e) => {
            if (this.customSelect && !this.customSelect.contains(e.target)) {
                this.customSelect.classList.remove('open');
            }
        });

        this.customOptions.forEach(option => {
            option.addEventListener('click', () => {
                if (!option.classList.contains('selected')) {
                    // Update visual Selection
                    this.customOptions.forEach(op => op.classList.remove('selected'));
                    option.classList.add('selected');

                    // Update Trigger Text
                    const modelName = option.textContent.trim();
                    this.selectedAmpName.textContent = modelName;

                    // Get Value
                    const model = option.dataset.value;

                    // Update Audio
                    this.audio.setAmpModel(model);

                    // Update UI Theme (Skin)
                    this.updateTheme(model);

                    // Update Cab Display text if default
                    if (this.cabNameDisplay.textContent.startsWith("Pro IR")) {
                        const cabNames = {
                            'fender_clean': 'Pro IR: CLEAN (USA)',
                            'vox_chime': 'Pro IR: CHIME (UK)',
                            'marshall_drive': 'Pro IR: DRIVE (BRIT)'
                        };
                        this.cabNameDisplay.textContent = cabNames[model] || "Pro IR: Custom";
                    }
                }
                this.customSelect.classList.remove('open');
            });
        });

        // --- Switches ---
        this.switches.forEach(sw => {
            sw.addEventListener('change', (e) => {
                const param = e.target.id.replace('sw-', '');
                const isActive = e.target.checked;

                if (param === 'gate') {
                    if (!isActive) this.audio.setGateThreshold(0);
                    else {
                        const knob = document.getElementById('knob-gate-thresh');
                        this.audio.setGateThreshold(parseFloat(knob.dataset.value));
                    }
                } else {
                    this.audio.toggleSwitch(param, isActive);
                }
            });
        });

        // --- IR Upload ---
        if (this.irUpload) {
            this.irUpload.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (!file) return;

                const reader = new FileReader();
                reader.onload = async (event) => {
                    const arrayBuffer = event.target.result;
                    const success = await this.audio.loadIR(arrayBuffer);
                    if (success) {
                        this.cabNameDisplay.textContent = `Custom IR: ${file.name}`;
                    }
                };
                reader.readAsArrayBuffer(file);
            });
        }
    }

    updateTheme(model) {
        // Remove all skin classes
        this.ampHead.classList.remove('skin-fender', 'skin-vox', 'skin-marshall');

        // Add new skin class (map extended models to base skins)
        let skin = 'fender';
        if (model.includes('vox')) skin = 'vox';
        if (model.includes('marshall')) skin = 'marshall';

        this.ampHead.classList.add(`skin-${skin}`);
    }

    setupKnobInteractions() {
        document.addEventListener('mousemove', (e) => this.handleDrag(e));
        document.addEventListener('mouseup', () => this.endDrag());

        this.knobs.forEach(knob => {
            knob.addEventListener('mousedown', (e) => this.startDrag(e, knob));

            // Set initial rotation
            const min = parseFloat(knob.dataset.min);
            const max = parseFloat(knob.dataset.max);
            const val = parseFloat(knob.dataset.value);
            this.updateKnobVisual(knob, val, min, max);
        });
    }

    startDrag(e, knob) {
        this.isDragging = true;
        this.currentKnob = knob;
        this.startY = e.clientY;
        this.startValue = parseFloat(knob.dataset.value);

        knob.parentElement.classList.add('is-dragging');
        document.body.style.cursor = 'ns-resize';
        e.preventDefault();
        e.stopPropagation(); // Stop event from bubbling to overlays
    }

    handleDrag(e) {
        if (!this.isDragging || !this.currentKnob) return;

        const deltaY = this.startY - e.clientY;

        const min = parseFloat(this.currentKnob.dataset.min);
        const max = parseFloat(this.currentKnob.dataset.max);
        const range = max - min;
        const step = range / 200;

        let newValue = this.startValue + (deltaY * step);
        newValue = Math.min(Math.max(newValue, min), max);

        this.currentKnob.dataset.value = newValue;
        this.updateKnobVisual(this.currentKnob, newValue, min, max);

        const tooltip = this.currentKnob.parentElement.querySelector('.floating-tooltip');
        if (tooltip) {
            let displayVal = newValue.toFixed(1);
            if (this.currentKnob.dataset.param === 'gate') displayVal += ' dB';
            tooltip.textContent = displayVal;
        }

        this.audio.setParam(this.currentKnob.dataset.param, newValue);
    }

    endDrag() {
        if (this.isDragging && this.currentKnob) {
            this.currentKnob.parentElement.classList.remove('is-dragging');
        }
        this.isDragging = false;
        this.currentKnob = null;
        document.body.style.cursor = 'default';
    }

    updateKnobVisual(knob, value, min, max) {
        const percent = (value - min) / (max - min);
        const angle = -135 + (percent * 270);
        knob.style.transform = `rotate(${angle}deg)`;
    }

    startVisualizer() {
        const draw = () => {
            if (this.audio && this.audio.isInitialized) {
                const dataArray = new Uint8Array(this.audio.nodes.analyser.frequencyBinCount);
                this.audio.getAnalyserData(dataArray);

                let sum = 0;
                for (let i = 0; i < dataArray.length; i++) {
                    sum += dataArray[i];
                }
                const average = sum / dataArray.length;
                // Boost visuals
                const height = Math.min(100, (average / 32) * 100);

                if (this.vuOut) this.vuOut.style.width = `${height}%`;
            }
            this.rafId = requestAnimationFrame(draw);
        };
        draw();
    }
}

// --- Main Init ---
document.addEventListener('DOMContentLoaded', () => {
    const audioEngine = new AudioEngine();
    const uiController = new UIController(audioEngine);

    // Initialize UI (listeners) immediately
    uiController.init();

    // Audio engine lazy loads on first user interaction (Power Button)
});
