# Device Specifications & System Requirements

## Overview
Minecraft-W Version 9 is a browser-based voxel sandbox engine built with Three.js. It runs entirely in the browser with procedural generation and requires no backend or account system.

---

## Minimum System Requirements

### Processor
- **Desktop/Laptop:** Intel Core i3 or equivalent (2.4 GHz or faster)
- **Mobile:** Qualcomm Snapdragon 400 series or equivalent
- **Requirements:** 64-bit processor, SSE2 support

### RAM
- **Desktop/Laptop:** 2 GB minimum (4 GB recommended)
- **Mobile:** 1 GB minimum (2 GB recommended for optimal performance)

### Storage
- **Disk Space:** 150 MB for initial installation and game files
- **Cache:** Additional 200-500 MB for generated world data
- **Temporary Space:** 1 GB free space recommended for smooth world generation

### Display
- **Resolution:** Minimum 640×480 (Full HD 1920×1080 recommended)
- **Refresh Rate:** 60 Hz minimum, 120+ Hz supported
- **GPU VRAM:** 512 MB minimum (1+ GB recommended)

### Network
- **Bandwidth:** 2 Mbps minimum, 10 Mbps recommended
- **Latency:** Works offline; networking for future multiplayer features planned
- **Type:** WebSocket support required for future networking features

---

## Recommended System Requirements

### Processor
- Intel Core i5/i7 or AMD Ryzen 5/7 (3.0 GHz or faster)
- Qualcomm Snapdragon 800 series or newer (mobile)
- Multi-core processor (4+ cores recommended)

### RAM
- **Desktop/Laptop:** 8 GB minimum
- **Mobile:** 4 GB minimum

### Storage
- **Disk Space:** 500 MB
- **Generated Worlds:** 1-5 GB per persistent world (depends on exploration)

### Display
- **Resolution:** 1920×1080 or higher
- **Refresh Rate:** 144+ Hz for smooth gameplay
- **GPU:** Dedicated graphics card with 2+ GB VRAM
  - NVIDIA: GTX 1050 Ti or better
  - AMD: RX 580 or better
  - Intel: Iris Xe or Arc series

---

## Browser Compatibility

### Desktop Browsers
| Browser | Minimum Version | Status |
|---------|-----------------|--------|
| Chrome/Chromium | 90+ | ✅ Full Support |
| Firefox | 88+ | ✅ Full Support |
| Safari | 14+ | ✅ Full Support |
| Edge | 90+ | ✅ Full Support |
| Opera | 76+ | ✅ Full Support |

### Mobile Browsers
| Browser | Minimum Version | Status |
|---------|-----------------|--------|
| Chrome Mobile | 90+ | ✅ Full Support |
| Safari iOS | 14+ | ✅ Full Support |
| Firefox Mobile | 88+ | ✅ Full Support |
| Samsung Internet | 14+ | ✅ Full Support |

### Required Browser Features
- **WebGL 2.0** - For 3D rendering
- **Web Workers** - For background chunk generation
- **Canvas 2D API** - For UI rendering
- **LocalStorage** - For settings and world persistence (min 5 MB)
- **IndexedDB** - Recommended for world data caching
- **Typed Arrays** - For efficient block data handling
- **ES6+ JavaScript** - Arrow functions, destructuring, async/await

---

## GPU Requirements

### Minimum Capable GPUs
- NVIDIA: GeForce GT 1030, GTX 750 Ti
- AMD: Radeon RX 460, R7 370
- Intel: UHD 630, Iris Xe

### Recommended GPUs
- NVIDIA: RTX 3060, GTX 1080 Ti or newer
- AMD: RX 5700 XT or newer
- Intel: Arc A770, A750

### VRAM Scaling
| VRAM | Typical Draw Distance | Performance |
|------|----------------------|-------------|
| 512 MB | 4-6 chunks | 30-45 FPS |
| 1 GB | 8-12 chunks | 60+ FPS |
| 2 GB | 16-20 chunks | 90+ FPS |
| 4+ GB | 24+ chunks | 120+ FPS |

---

## Input Device Support

### Keyboard & Mouse
- **Mouse:** Required for desktop play
- **Keyboard:** Standard QWERTY layout
- **Resolution:** 400+ DPI recommended for mouse
- **Sensitivity Range:** Configurable (0.1x to 5x)

### Touch Input (Mobile)
- **Minimum Touchscreen:** 3.5" diagonal for phones
- **Recommended:** 5.5"+ for phones, 7"+ for tablets
- **Touch Sensitivity:** 10-point multitouch support
- **On-Screen Controls:** Optimized for portrait and landscape

### Gamepad Support
- **API:** Gamepad API (W3C standard)
- **Controllers:** Xbox, PlayStation, Generic HID
- **Minimum Buttons:** 14 buttons + 2 analog sticks
- **Status:** Full support

### Other Devices
- **Headphone Jack/BT:** For audio output
- **Microphone:** Optional for future voice chat

---

## Display & Graphics Settings

### Rendering Quality Presets

#### Fast (Intel HD, Mobile, Older GPUs)
- Draw Distance: 6 chunks
- Shadow Quality: Off
- Ambient Occlusion: Off
- Particle Effects: Reduced (30%)
- Target FPS: 30-60

#### Medium (GTX 1050, Standard)
- Draw Distance: 12 chunks
- Shadow Quality: Medium
- Ambient Occlusion: On
- Particle Effects: Normal (100%)
- Target FPS: 60

#### Ultra (RTX 3070+, High-End)
- Draw Distance: 24+ chunks
- Shadow Quality: High
- Ambient Occlusion: Enhanced
- Particle Effects: Full (150%)
- Target FPS: 120+

### Resolution Support
- 640×480 to 7680×4320 (8K)
- Aspect Ratios: 4:3, 16:9, 16:10, 21:9 ultrawide
- Fullscreen and Windowed modes
- Borderless fullscreen option

### FOV & Rendering
- Field of View: 30° to 110° (configurable)
- Render Distance: 4-32 chunks (chunking system)
- Fog Enabled: Reduces memory usage on lower-end systems
- VSync: On/Off toggle

---

## Performance Targets

### Frame Rate Expectations
| System | Settings | Expected FPS | World Size |
|--------|----------|--------------|-----------|
| Budget (i3, GTX 750) | Fast | 30-45 | 1-2 GB worlds |
| Mid-Range (i5, RTX 2060) | Medium | 60-90 | 3-5 GB worlds |
| High-End (i7, RTX 3080+) | Ultra | 120+ | 10+ GB worlds |
| Mobile (Snapdragon 800+) | Medium-Fast | 30-60 | 1-2 GB worlds |

### Chunk Generation Performance
- **Generation Speed:** 1-3 chunks per second (varies by CPU)
- **Meshing Speed:** 4-8 chunks per second
- **Memory Overhead:** ~2.5 MB per loaded chunk (varies)

---

## Audio Requirements

### Output
- **Sample Rate:** 44.1 kHz minimum, 48 kHz recommended
- **Bit Depth:** 16-bit minimum
- **Channels:** Stereo or surround support
- **Latency:** <100 ms recommended

### Input
- **Microphone:** USB or built-in (for future voice features)
- **Minimum Frequency Response:** 100 Hz - 8 kHz

---

## Network Requirements

### For Future Multiplayer Features
- **Bandwidth:** 256 Kbps minimum per player
- **Latency:** <200 ms acceptable, <100 ms ideal
- **Packet Loss:** <1% acceptable
- **Connection Type:** Any TCP/WebSocket capable connection

### Storage Services
- **Cloud Saves (future):** Requires login account
- **Data per World:** 1-10 MB for world metadata (saves)
- **Upload Speed:** 1 Mbps sufficient

---

## Accessibility Requirements

### Input Accessibility
- Keyboard-only play support
- Remappable controls
- Adjustable mouse sensitivity

### Visual Accessibility
- Adjustable UI scale (50-200%)
- Colorblind-friendly palette options (planned)
- Text scaling for HUD elements
- Adjustable brightness/contrast

### Audio Accessibility
- Optional audio descriptions (planned)
- Subtitles for narrative elements (planned)
- Visual sound indicators (planned)

---

## Installation & Storage

### Installation Methods
- **Web Browser:** Direct play via URL (no installation needed)
- **Progressive Web App (PWA):** Installable for offline play
- **Desktop Shortcut:** Create desktop launcher
- **Mobile Home Screen:** iOS/Android app shortcut

### Storage Breakdown
| Component | Size |
|-----------|------|
| Game Engine | 2-5 MB (compressed) |
| Textures & Assets | 10-20 MB |
| Audio Files | 5-10 MB |
| World Saves (per world) | 1-10 MB |
| Browser Cache | 100-500 MB |
| **Total Installation** | **150 MB** |

---

## Known Limitations by Platform

### Desktop
- ✅ Full feature support
- ✅ All graphics quality levels
- ✅ Mouse + keyboard + gamepad
- ⚠️ Safari: Some WebGL2 features limited

### Mobile (iOS)
- ✅ Core gameplay
- ⚠️ Limited to Medium graphics preset
- ⚠️ Touch controls (no gamepad on older iOS)
- ⚠️ IndexedDB storage limited to ~50 MB per app

### Mobile (Android)
- ✅ Full feature support (depends on device)
- ✅ Gamepad support
- ⚠️ Storage limits vary by device/manufacturer
- ⚠️ Chrome's quota: 6% of disk space

### Legacy Browsers (<90)
- ❌ Not supported
- Workaround: Update browser or use a supported browser

---

## Testing & Verification

### Hardware Testing Checklist
- [ ] Processor: Run `navigator.hardwareConcurrency` in console
- [ ] RAM: Check `performance.memory` (available in Chrome DevTools)
- [ ] GPU: Check WebGL capabilities in DevTools
- [ ] Storage: Test with `navigator.storage` API
- [ ] Network: Run speed test at fast.com

### Browser Feature Detection
```javascript
// Check browser capabilities
const features = {
  webgl2: !!document.createElement('canvas').getContext('webgl2'),
  workers: typeof Worker !== 'undefined',
  indexeddb: !!window.indexedDB,
  storage: navigator.storage !== undefined
};
```

---

## Recommended Upgrades for Better Experience

1. **SSD instead of HDD** - Faster world loading and saves
2. **USB 3.0+ External Storage** - For backing up large worlds
3. **High Refresh Rate Monitor** - 144+ Hz for smooth gameplay
4. **Dedicated GPU** - iGPU works, but discrete GPU recommended
5. **Good Internet Connection** - For future multiplayer features
6. **Quality Headphones** - Better audio immersion

---

## Troubleshooting Performance

### Low FPS?
1. Reduce draw distance (Settings → Graphics)
2. Lower graphics preset to "Fast"
3. Close other browser tabs
4. Update GPU drivers
5. Check for background applications

### Crashes or Lag Spikes?
1. Clear browser cache
2. Close other applications
3. Check available RAM
4. Try a different browser
5. Disable browser extensions

### Storage Full?
1. Clear browser cache
2. Delete old world saves
3. Use browser's storage management (Settings → Storage)

---

## Version History

| Version | Date | Key Changes |
|---------|------|-------------|
| 9.0.0 | 2025-09-21 | Initial device specs documentation |

---

**Last Updated:** 2025-09-21  
**Maintained by:** Development Team  
**License:** MIT
