export class UIController {
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

        // Settings Controls
        this.audioOutputSelect = document.getElementById('audio-output-select');
        this.bufferSizeSelect = document.getElementById('buffer-size-select');

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
            this.settingsBtn.addEventListener('click', async () => {
                this.settingsModal.classList.add('active');

                // Populate audio output devices
                await this.populateAudioDevices();

                // Set current buffer size selection
                if (this.bufferSizeSelect) {
                    const currentBufferSize = this.audio.bufferSize || 128;
                    this.bufferSizeSelect.value = currentBufferSize.toString();
                }
            });
        }
        if (this.closeSettingsBtn) {
            this.closeSettingsBtn.addEventListener('click', () => {
                this.settingsModal.classList.remove('active');
            });
        }

        // Audio Output Device Change
        if (this.audioOutputSelect) {
            this.audioOutputSelect.addEventListener('change', (e) => {
                this.audio.setOutputDevice(e.target.value);
            });
        }

        // Buffer Size Change
        if (this.bufferSizeSelect) {
            this.bufferSizeSelect.addEventListener('change', (e) => {
                const newSize = parseInt(e.target.value);
                this.audio.setBufferSize(newSize);

                // Show notification that restart is needed
                alert('Buffer size updated. Please refresh the page for changes to take effect.');
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
                    if (this.cabNameDisplay.textContent.startsWith("Default Cab")) {
                        const cabNames = {
                            'fender': 'Default Cab: 1x12 Open Back',
                            'vox': 'Default Cab: 2x12 Blue',
                            'marshall': 'Default Cab: 4x12 V30'
                        };
                        this.cabNameDisplay.textContent = cabNames[model];
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
        // Add new skin class
        this.ampHead.classList.add(`skin-${model}`);
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

    async populateAudioDevices() {
        if (!this.audioOutputSelect) return;

        const devices = await this.audio.getAudioOutputDevices();

        // Clear existing options except default
        this.audioOutputSelect.innerHTML = '<option value="default">System Default</option>';

        // Add available devices
        devices.forEach(device => {
            const option = document.createElement('option');
            option.value = device.deviceId;
            option.textContent = device.label || `Audio Device ${device.deviceId.substring(0, 8)}`;
            this.audioOutputSelect.appendChild(option);
        });

        // Set current selection
        const currentDevice = this.audio.audioOutputDeviceId || 'default';
        this.audioOutputSelect.value = currentDevice;
    }
}
