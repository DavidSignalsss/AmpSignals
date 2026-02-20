export class AudioEngine {
    constructor() {
        this.ctx = null;
        this.nodes = {};
        this.isInitialized = false;
        this.currentAmp = 'fender'; // Default
        this.audioOutputDeviceId = 'default';
        this.bufferSize = 128; // Default buffer size in ms

        // State for switches to logic mapping
        this.state = {
            bright: false,
            drive: false
        };
    }

    async init() {
        if (this.isInitialized) return;

        // Load preferences from localStorage
        const savedBufferSize = localStorage.getItem('bufferSize');
        if (savedBufferSize) {
            this.bufferSize = parseInt(savedBufferSize);
        }

        const savedOutputDevice = localStorage.getItem('audioOutputDevice');
        if (savedOutputDevice) {
            this.audioOutputDeviceId = savedOutputDevice;
        }

        // Map buffer size (ms) to latencyHint
        let latencyHint = 'interactive'; // default
        if (this.bufferSize <= 64) latencyHint = 'interactive';
        else if (this.bufferSize <= 128) latencyHint = 'balanced';
        else latencyHint = 'playback';

        this.ctx = new (window.AudioContext || window.webkitAudioContext)({
            latencyHint: latencyHint,
            sampleRate: 48000
        });

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
        this.setInternalCab('fender'); // Default load

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
                const multiplier = this.state.drive ? 2.0 : 1.0;
                this.nodes.preGain.gain.value = value * multiplier;
                // Update distortion curve based on new gain value
                this.updateDistortion();
                break;
            case 'voice':
                // Enhanced voice control for harmonic richness
                // Positive values boost mids for warmth, negative values scoop for clarity
                this.nodes.voice.gain.value = value * 3; // -5 to 5 -> -15dB to 15dB
                // Adjust Q for more musical response
                this.nodes.voice.Q.value = 1.5 + Math.abs(value) * 0.2;
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

    setAmpModel(model) {
        this.currentAmp = model;
        this.updateDistortion();
        this.setInternalCab(model);
    }

    updateDistortion() {
        // Get current gain value to determine distortion amount
        const currentGain = this.nodes.preGain.gain.value;

        // Base distortion amounts for each amp (much lower for cleaner tones)
        let baseAmount = 0;

        if (this.currentAmp === 'fender') {
            // Fender Deluxe: Clean with warm tube compression
            baseAmount = this.state.drive ? 8 : 0.5;
        } else if (this.currentAmp === 'vox') {
            // VOX AC30: Chimey with moderate breakup
            baseAmount = this.state.drive ? 15 : 2;
        } else if (this.currentAmp === 'marshall') {
            // Marshall Plexi: Clear articulation with controlled gain
            baseAmount = this.state.drive ? 25 : 3;
        }

        // Scale distortion based on actual gain setting (only add distortion if gain > 2)
        const gainFactor = Math.max(0, (currentGain - 2) / 8);
        const finalAmount = baseAmount * (0.2 + gainFactor * 0.8);

        this.nodes.distortion.curve = this.makeDistortionCurve(finalAmount);
    }

    // --- IR / Cab ---

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

    setInternalCab(model) {
        // Synthetic IR generation (same as before but slightly tweaked)
        const duration = 0.5; // seconds
        const rate = this.ctx.sampleRate;
        const length = rate * duration;
        const impulse = this.ctx.createBuffer(2, length, rate);
        const left = impulse.getChannelData(0);
        const right = impulse.getChannelData(1);

        for (let i = 0; i < length; i++) {
            let val = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 4); // Exp decay

            // Simple FIR filtering for tone
            if (model === 'fender') {
                if (i % 2 === 0) val *= 0.9; // Slight low pass
            } else if (model === 'marshall') {
                // Mid boost simulation (cheesy but works)
                if (i > 2) val = (val + left[i - 1] + left[i - 2]) / 3;
            } else if (model === 'vox') {
                val *= 0.8; // Quieter, compressed
            }

            left[i] = val;
            right[i] = val;
        }
        this.nodes.cab.buffer = impulse;
    }

    makeDistortionCurve(amount) {
        const n_samples = 44100;
        const curve = new Float32Array(n_samples);

        for (let i = 0; i < n_samples; ++i) {
            const x = i * 2 / n_samples - 1;

            if (amount < 1) {
                // Very clean - minimal saturation, just soft clipping
                curve[i] = x * (1 - 0.1 * amount);
            } else {
                // Smooth tube-like saturation using tanh-based curve
                const k = amount * 0.5;
                curve[i] = Math.tanh(k * x) / Math.tanh(k);
            }
        }
        return curve;
    }

    getAnalyserData(array) {
        if (this.nodes.analyser) {
            this.nodes.analyser.getByteFrequencyData(array);
        }
    }

    async getAudioOutputDevices() {
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            return devices.filter(device => device.kind === 'audiooutput');
        } catch (err) {
            console.error('Error enumerating audio devices:', err);
            return [];
        }
    }

    async setOutputDevice(deviceId) {
        this.audioOutputDeviceId = deviceId;

        // Note: Web Audio API doesn't directly support output device selection
        // This would require using HTMLMediaElement with setSinkId()
        // For now, we store the preference and it can be used with MediaElement routing

        // Store preference
        localStorage.setItem('audioOutputDevice', deviceId);
        console.log('Audio output device set to:', deviceId);

        // In a full implementation, you would:
        // 1. Create a MediaStreamDestination from the audio graph
        // 2. Create an HTMLAudioElement
        // 3. Use setSinkId() on the audio element
        // 4. Connect the MediaStreamDestination to the audio element
    }

    setBufferSize(sizeMs) {
        this.bufferSize = sizeMs;
        localStorage.setItem('bufferSize', sizeMs);

        // Note: Changing buffer size requires recreating the AudioContext
        // with the latencyHint option. This is a complex operation that
        // would require reinitializing the entire audio graph.
        // For now, we store the preference for next initialization.

        console.log('Buffer size preference set to:', sizeMs, 'ms');
        console.log('Note: Buffer size will take effect on next audio engine restart');
    }
}
