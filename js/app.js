/**
 * FieldSpectralView — Static Replica (Vanilla JS)
 * Full-featured agricultural multispectral viewer
 */
(() => {
    'use strict';

    // ===========================
    //  STATE
    // ===========================
    const state = {
        currentDataset: null,     // loaded JSON data
        datasetId: null,
        mode: 'compare',          // compare | sxs | alpha | mapper
        activeTool: 'pointer',    // pointer | marker
        layer1Idx: 0,
        layer2Idx: 1,
        alphaOpacity: 50,
        sidebarOpen: true,
        sidebarTab: 'layers',
        selectedAnnotationId: null,
        transform: { scale: 1, x: 0, y: 0 },
        isDragging: false,
        dragStart: { x: 0, y: 0 },
        sliderPos: 50,            // percent for compare slider
        isSliderDragging: false,
        plotVisibleIds: [],       // measurement IDs visible in plot
        spectralChart: null,
        viActive: null,           // active VI object
        viAvailableBands: []      // array of available bands
    };

    const PLOT_COLORS = ['#047842', '#ef4444', '#3b82f6', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6'];

    // ===========================
    //  BAND → NM RANGE TABLE
    // ===========================
    const BAND_NM_INFO = {
        'RGB':   { range: '400–700 nm',  label: 'Visible (RGB)',  color: '#e5e7eb' },
        'BLUE':  { range: '400–500 nm',  label: 'Blue',           color: '#60a5fa' },
        'GREEN': { range: '500–600 nm',  label: 'Green',          color: '#4ade80' },
        'RED':   { range: '600–700 nm',  label: 'Red',            color: '#f87171' },
        'RE':    { range: '700–760 nm',  label: 'Red Edge',       color: '#fb923c' },
        'NIR':   { range: '760–900+ nm', label: 'Near-Infrared',  color: '#c084fc' }
    };

    // ===========================
    //  SESSION STATE (browser-only, no server)
    // ===========================
    const session = {
        isActive: false,
        id: null,
        layerFiles: [],  // { file, objectUrl, filename, description, band }
        viBlobs: {}      // { viId: { blob, filename, objectUrl } }
    };
    let _pendingFiles = []; // files staged in the session modal before creation

    // ===========================
    //  VEGETATION INDICES (VIs)
    // ===========================
    const VI_DEFINITIONS = [
        { id: 'ndvi', name: 'NDVI', formula: '(NIR - RED)/(NIR + RED)', bands: ['NIR', 'RED'], desc: 'Normalized Difference. Good for general plant health.', min: -1, max: 1 },
        { id: 'gndvi', name: 'GNDVI', formula: '(NIR - GREEN)/(NIR + GREEN)', bands: ['NIR', 'GREEN'], desc: 'Green NDVI. Sensitive to chlorophyll concentration.', min: -1, max: 1 },
        { id: 'sr', name: 'SR (RVI)', formula: 'NIR / RED', bands: ['NIR', 'RED'], desc: 'Simple Ratio. Correlates with biomass and LAI.', min: 0, max: 30 },
        { id: 'ndre', name: 'NDRE', formula: '(NIR - RE)/(NIR + RE)', bands: ['NIR', 'RE'], desc: 'Red-Edge NDVI. Detects early stress.', min: -1, max: 1 },
        { id: 'savi', name: 'SAVI', formula: '1.5 * (NIR-RED)/(NIR+RED+0.5)', bands: ['NIR', 'RED'], desc: 'Soil-Adjusted. Minimizes soil background influence.', min: -1, max: 1 },
        { id: 'osavi', name: 'OSAVI', formula: '1.16 * (NIR-RED)/(NIR+RED+0.16)', bands: ['NIR', 'RED'], desc: 'Optimized SAVI. Good for sparse canopies.', min: -1, max: 1 },
        { id: 'msavi2', name: 'MSAVI2', formula: 'Auto-adjusted soil correction', bands: ['NIR', 'RED'], desc: 'Modified SAVI. No need for soil line parameters.', min: -1, max: 1 },
        { id: 'tvi', name: 'TVI', formula: 'Triangular Area', bands: ['NIR', 'RED', 'GREEN'], desc: 'Triangular VI. Indicates overall plant vigor.', min: 0, max: 100 },
        { id: 'evi', name: 'EVI', formula: 'Atmospheric correction', bands: ['NIR', 'RED', 'BLUE'], desc: 'Enhanced VI. Resists atmospheric interference.', min: -1, max: 1 },
        { id: 'vari', name: 'VARI', formula: '(G - R)/(G + R - B)', bands: ['GREEN', 'RED', 'BLUE'], desc: 'Visible Atmospherically Resistant. Uses only visible light.', min: -1, max: 1 }
    ];

    // ===========================
    //  DOM REFS
    // ===========================
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);

    // ===========================
    //  WAVELENGTH → BAND MAPPING
    // ===========================
    /**
     * Maps a wavelength (nm) to a standard spectral band label.
     * Used to auto-detect which spectral band a layer represents.
     */
    function wavelengthToBand(nm) {
        if (nm <= 0) return null;
        if (nm >= 400 && nm < 500) return 'BLUE';
        if (nm >= 500 && nm < 600) return 'GREEN';
        if (nm >= 600 && nm < 700) return 'RED';
        if (nm >= 700 && nm < 760) return 'RE';   // Red Edge
        if (nm >= 760)             return 'NIR';
        return null;
    }

    /**
     * Parses a layer description string (from backend) and extracts
     * a wavelength in nm, then maps it to a band.
     * Examples:
     *   "685nm"                    → RED
     *   "CALIB_FILTER_850"         → NIR
     *   "FILTER_740"              → RE
     *   "RGB"                     → RGB
     */
    function descriptionToBand(desc) {
        if (!desc) return null;
        const upper = desc.toUpperCase();

        // Direct name matches
        if (upper === 'RGB' || upper.includes('_RGB')) return 'RGB';
        if (upper === 'NIR' || upper === 'INFRARED') return 'NIR';
        if (upper === 'RED_EDGE' || upper === 'REDEDGE' || upper === 'RE') return 'RE';

        // Try to extract a numeric wavelength
        // Patterns: "685nm", "FILTER_685", "CALIB_FILTER_685", "685"
        const nmMatch = upper.match(/(\d{3,4})\s*(?:NM)?/);
        if (nmMatch) {
            const nm = parseInt(nmMatch[1]);
            if (nm >= 300 && nm <= 1100) {
                return wavelengthToBand(nm);
            }
        }

        // Fallback: check for color keywords
        if (upper.includes('BLUE')) return 'BLUE';
        if (upper.includes('GREEN')) return 'GREEN';
        if (upper.includes('RED') && !upper.includes('INFRARED')) return 'RED';

        return null; // Unknown band
    }

    // ===========================
    //  PROJECT DATA NORMALIZER
    // ===========================
    /**
     * Normalizes a backend project JSON into the static site format.
     * Handles both formats:
     *  - Static format:  { layers: [{ filename, band, description }], metadata: { author, ... } }
     *  - Backend format: { layers: [{ imageUrl, description, type }], metadata: { artist, title, ... } }
     */
    function normalizeProjectData(raw, projectId) {
        if (!raw) return { metadata: {}, layers: [], annotations: [] };
        // If it already has the static format markers, return as-is (with minimal fixes)
        const isBackendFormat = raw.layers?.some(l => l.imageUrl && !l.filename);

        const data = JSON.parse(JSON.stringify(raw)); // deep clone

        // --- Normalize metadata ---
        if (!data.metadata) data.metadata = {};
        const m = data.metadata;

        // Backend uses 'artist', static uses 'author'
        if (!m.author && m.artist) m.author = m.artist;
        if (!m.author) m.author = 'Unknown';
        if (!m.date) m.date = data.timestamp || data.last_modified || '—';
        if (!m.coordinates) m.coordinates = '—';
        if (!m.sensor && m.technique) m.sensor = m.technique;
        if (!m.sensor) m.sensor = '—';

        // --- Normalize layers ---
        if (data.layers) {
            data.layers = data.layers.map(layer => {
                const normalized = { ...layer };

                // Extract filename from imageUrl if missing
                if (!normalized.filename && normalized.imageUrl) {
                    // imageUrl format: "/api/files/registered_xxx_685nm.png"
                    const urlParts = normalized.imageUrl.split('/');
                    normalized.filename = urlParts[urlParts.length - 1];
                }

                // Ensure description exists
                if (!normalized.description) {
                    normalized.description = normalized.filename || 'Unknown Layer';
                }

                // Auto-detect band from description if missing
                if (!normalized.band) {
                    normalized.band = descriptionToBand(normalized.description);
                }

                // Remove 'type' if it's a backend-style type like 'Custom Upload'
                // Keep it if it's a useful static type
                if (normalized.type === 'Custom Upload') {
                    delete normalized.type;
                }

                return normalized;
            });

            // Filter out layers with no filename (broken references)
            data.layers = data.layers.filter(l => l.filename);
        }

        // --- Normalize annotations ---
        if (!data.annotations) data.annotations = [];
        data.annotations.forEach((ann, i) => {
            if (!ann.id) ann.id = `ann_${i + 1}`;
            if (ann.index === undefined) ann.index = i + 1;
            if (!ann.type) ann.type = 'Observation';
            if (!ann.description) ann.description = '';
            if (!ann.measurements) ann.measurements = [];
        });

        return data;
    }

    // ===========================
    //  DATA LOADER (Auto-Discovery)
    // ===========================

    /**
     * Known project IDs to scan for when index.json is missing.
     * This list is populated by scanning known project folders.
     * Since static sites can't list directories, we use a two-pronged approach:
     *  1. Try loading index.json first
     *  2. If missing, try a manifest file or probe known project IDs
     */
    async function loadDatasetIndex() {
        console.log('[FieldSpectralView] Starting dataset discovery...');

        // Step 1: Load pre-built summaries from index.json (optional, for cached info)
        let indexDatasets = [];
        try {
            const res = await fetch('datasets/index.json');
            if (res.ok) {
                const idx = await res.json();
                if (Array.isArray(idx.datasets)) indexDatasets = idx.datasets;
            }
        } catch (err) {
            console.warn('[FieldSpectralView] index.json not loaded', err);
        }

        // Step 2: Always consult manifest.json for the authoritative project list
        // This ensures projects added to manifest but not yet in index.json are shown
        let manifestProjects = [];
        try {
            const res = await fetch('datasets/manifest.json');
            if (res.ok) {
                const manifest = await res.json();
                if (Array.isArray(manifest.projects)) manifestProjects = manifest.projects;
            }
        } catch (err) {
            console.warn('[FieldSpectralView] manifest.json not loaded', err);
        }

        // Step 3: Probe any manifest project not already in index.json
        const indexIds = new Set(indexDatasets.map(d => d.id));
        for (const projId of manifestProjects) {
            if (!indexIds.has(projId)) {
                const info = await probeProject(projId);
                if (info) indexDatasets.push(info);
            }
        }

        if (indexDatasets.length === 0 && window.location.protocol === 'file:') {
            showFileProtocolWarning();
        }

        return { datasets: indexDatasets };
    }

    /**
     * Probes a single project folder to extract summary info for the archive grid.
     * Tries both data.json (static format) and {id}.json (backend format).
     */
    async function probeProject(projId) {
        let data = null;

        // Try backend format first ({id}.json)
        try {
            const res = await fetch(`datasets/${projId}/${projId}.json`);
            if (res.ok) data = await res.json();
        } catch { /* fallthrough */ }

        // Fallback to static format (data.json)
        if (!data) {
            try {
                const res = await fetch(`datasets/${projId}/data.json`);
                if (res.ok) data = await res.json();
            } catch { /* fallthrough */ }
        }

        if (!data) return null;

        // Normalize
        const norm = normalizeProjectData(data, projId);
        const m = norm.metadata || {};

        return {
            id: projId,
            title: m.title || projId,
            description: m.description || '',
            author: m.author || 'Unknown',
            year: m.year || '—',
            layerCount: (norm.layers || []).length,
            annotationCount: (norm.annotations || []).length,
            thumbnail: norm.layers?.[0]?.filename || null
        };
    }

    async function loadDataset(id) {
        let rawData = null;

        // Try backend format first ({id}.json)
        try {
            const res = await fetch(`datasets/${id}/${id}.json`);
            if (res.ok) rawData = await res.json();
        } catch { /* fallthrough */ }

        // Fallback to static format (data.json)
        if (!rawData) {
            try {
                const res = await fetch(`datasets/${id}/data.json`);
                if (res.ok) rawData = await res.json();
            } catch { /* fallthrough */ }
        }

        if (!rawData) {
            alert(`Could not load project: ${id}`);
            return null;
        }

        // Normalize to unified format
        const data = normalizeProjectData(rawData, id);
        
        state.currentDataset = data;
        state.datasetId = id;
        state.layer1Idx = 0;
        state.layer2Idx = Math.min(1, data.layers.length - 1);
        state.selectedAnnotationId = null;
        state.transform = { scale: 1, x: 0, y: 0 };
        state.sliderPos = 50;
        // default plot: show all measurements
        state.plotVisibleIds = [];
        data.annotations.forEach(a => a.measurements.forEach(m => state.plotVisibleIds.push(m.id)));
        return data;
    }

    // ===========================
    //  ARCHIVE VIEW
    // ===========================
    async function renderArchive() {
        const index = await loadDatasetIndex();
        const grid = $('#archive-grid');
        grid.innerHTML = '';

        // ---- "New Session" card (always first) ----
        const sessionCard = document.createElement('div');
        sessionCard.className = 'archive-card bg-[#1a1a1a] border-2 border-dashed border-gray-600 rounded-lg overflow-hidden cursor-pointer group hover:border-museum-accent transition-all flex flex-col';
        sessionCard.innerHTML = `
            <div class="flex-1 flex flex-col items-center justify-center gap-3 py-10">
                <div class="w-14 h-14 rounded-full border-2 border-dashed border-gray-600 group-hover:border-museum-accent flex items-center justify-center transition-colors">
                    <svg class="w-7 h-7 text-gray-500 group-hover:text-museum-accent transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>
                </div>
                <span class="text-sm font-bold text-gray-400 group-hover:text-museum-accent uppercase tracking-wider transition-colors">New Session</span>
            </div>
            <div class="p-4 border-t border-gray-800">
                <p class="text-[10px] text-gray-500 text-center leading-relaxed">Upload your images · process locally · download results</p>
            </div>`;
        sessionCard.addEventListener('click', () => showSessionModal());
        grid.appendChild(sessionCard);

        if (index.datasets.length === 0) {
            const hint = document.createElement('div');
            hint.className = 'text-gray-500 text-sm col-span-2 bg-[#1a1a1a] p-6 rounded-lg border border-gray-800';
            hint.innerHTML = `<p class="font-bold text-gray-300 mb-2">No archived datasets found</p>
                <p class="mb-3 text-[11px]">Copy project folders into <code class="bg-gray-800 px-1 rounded">datasets/</code> and add their IDs to <code class="bg-gray-800 px-1 rounded">datasets/manifest.json</code>.</p>
                <p class="text-[11px] text-museum-accent">→ Use "New Session" above to start a free local processing session.</p>`;
            grid.appendChild(hint);
            return;
        }

        index.datasets.forEach(ds => {
            // Build thumbnail URL: prefer vis.jpg, fallback to first layer file
            const thumbSrc = ds.thumbnail
                ? `datasets/${ds.id}/${ds.thumbnail}`
                : `datasets/${ds.id}/vis.jpg`;

            const card = document.createElement('div');
            card.className = 'archive-card bg-museum-800 border border-gray-700 rounded-lg overflow-hidden cursor-pointer group';
            card.innerHTML = `
                <div class="h-40 bg-black overflow-hidden relative">
                    <img src="${thumbSrc}" class="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22/>'">
                    <div class="absolute bottom-2 right-2 bg-museum-accent text-black text-[10px] font-bold px-2 py-0.5 rounded uppercase">${ds.layerCount} layers</div>
                </div>
                <div class="p-4">
                    <h3 class="text-sm font-bold text-white mb-1 group-hover:text-museum-accent transition-colors">${ds.title}</h3>
                    <p class="text-[11px] text-gray-400 mb-2 line-clamp-2">${ds.description}</p>
                    <div class="flex justify-between items-center text-[10px] text-gray-500">
                        <span>${ds.author} · ${ds.year}</span>
                        <span>${ds.annotationCount} pts</span>
                    </div>
                </div>`;
            card.addEventListener('click', () => openDataset(ds.id));
            grid.appendChild(card);
        });
    }

    // ===========================
    //  NAVIGATION
    // ===========================
    function showView(view) {
        $('#view-archive').classList.toggle('hidden', view !== 'archive');
        $('#view-analysis').classList.toggle('hidden', view !== 'analysis');
        $('#nav-archive').classList.toggle('text-white', view === 'archive');
        $('#nav-archive').classList.toggle('border-museum-accent', view === 'archive');
        $('#nav-archive').classList.toggle('border-transparent', view !== 'archive');
        $('#nav-analysis').classList.toggle('text-white', view === 'analysis');
        $('#nav-analysis').classList.toggle('border-museum-accent', view === 'analysis');
        $('#nav-analysis').classList.toggle('border-transparent', view !== 'analysis');
    }

    async function openDataset(id) {
        const data = await loadDataset(id);
        if (!data) return;
        showView('analysis');
        renderSidebar();
        setMode('compare');
        // Sync CSS transforms and slider DOM with the reset state
        applyTransform();
        $('#compare-left').style.clipPath = `inset(0 ${100 - state.sliderPos}% 0 0)`;
        $('#slider-handle').style.left = state.sliderPos + '%';
        renderAnnotations();
        updateChart();
    }

    // ===========================
    //  SIDEBAR
    // ===========================
    function renderSidebar() {
        const ds = state.currentDataset;
        if (!ds) return;
        const m = ds.metadata;

        // Header
        $('#project-title').textContent = m.title;
        $('#project-author').textContent = `${m.author} // ${m.year}`;
        $('#project-description').textContent = m.description;

        // Metadata panel
        const meta = $('#metadata-panel');
        meta.innerHTML = `
            <div class="flex justify-between items-center border-b border-gray-800 pb-1"><span class="text-gray-500">Date</span><span>${m.date || '—'}</span></div>
            <div class="flex justify-between items-center border-b border-gray-800 pb-1"><span class="text-gray-500">Coordinates</span><span class="text-xs">${m.coordinates || '—'}</span></div>
            <div class="flex justify-between items-center border-b border-gray-800 pb-1"><span class="text-gray-500">Sensor</span><span class="text-xs">${m.sensor || m.technique || '—'}</span></div>
            <div class="flex justify-between items-center"><span class="text-gray-500">Layers</span><span>${ds.layers.filter(l=>!l._isVI).length} <span class="text-gray-600 text-[9px]">${ds.layers.filter(l=>l._isVI).length ? '+ ' + ds.layers.filter(l=>l._isVI).length + ' VI' : ''}</span></span></div>`;

        // Layer dropdowns (VI layers are real entries in ds.layers now)
        const leftSel = $('#layer-left');
        const rightSel = $('#layer-right');
        leftSel.innerHTML = '';
        rightSel.innerHTML = '';
        ds.layers.forEach((l, i) => {
            leftSel.innerHTML += `<option value="${i}"${i === state.layer1Idx ? ' selected' : ''}>${l.description}</option>`;
            rightSel.innerHTML += `<option value="${i}"${i === state.layer2Idx ? ' selected' : ''}>${l.description}</option>`;
        });

        // Annotation count
        $('#annotation-count').textContent = `${ds.annotations.length} points`;

        // VIs Panel
        renderVIPanel();

        // Session-specific UI
        updateSessionExportUI();
    }

    function setSidebarTab(tab) {
        state.sidebarTab = tab;
        $$('.sidebar-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
        $$('.tab-content').forEach(el => el.classList.add('hidden'));
        $(`#tab-${tab}`)?.classList.remove('hidden');
    }

    // ===========================
    //  VIEW MODES
    // ===========================
    function setMode(mode) {
        state.mode = mode;
        ['compare', 'sxs', 'alpha', 'mapper'].forEach(m => {
            $(`#mode-${m}`)?.classList.toggle('hidden', m !== mode);
        });
        $$('.mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));

        // Alpha controls
        $('#alpha-controls')?.classList.toggle('hidden', mode !== 'alpha');

        // Update layer labels
        const l1Label = mode === 'alpha' ? 'Top' : 'Left';
        const l2Label = mode === 'alpha' ? 'Btm' : 'Right';
        $('#layer1-label').textContent = l1Label;
        $('#layer2-label').textContent = l2Label;

        // Mapper toolbar
        $('#mapper-toolbar')?.classList.toggle('hidden', mode !== 'mapper');

        // Sidebar toggle reposition
        const toggleBtn = $('#btn-toggle-sidebar');
        if (mode === 'mapper') {
            toggleBtn.classList.add('hidden');
        } else {
            toggleBtn.classList.remove('hidden');
        }

        // Status bar
        updateStatusBar();
        updateImages();
    }

    function updateStatusBar() {
        const ds = state.currentDataset;
        if (!ds) return;
        const l1 = ds.layers[state.layer1Idx];
        const l2 = ds.layers[state.layer2Idx];
        const modeNames = { compare: 'Slider', sxs: 'Side-by-Side', alpha: 'Alpha Blend', mapper: 'Mapper' };
        $('#status-layer').textContent = `Active: ${l1?.description || '—'} ${state.mode === 'sxs' ? `vs ${l2?.description || ''}` : ''}`;
        $('#status-tool').textContent = `Tool: ${state.mode === 'mapper' ? (state.activeTool === 'marker' ? 'Add Point' : 'Pan/Zoom') : modeNames[state.mode]}`;
    }

    // ===========================
    //  IMAGE MANAGEMENT
    // ===========================
    function getLayerUrl(idx) {
        const ds = state.currentDataset;
        if (!ds || !ds.layers[idx]) return '';
        // VI layers and session layers both carry _objectUrl
        if (ds.layers[idx]._objectUrl) return ds.layers[idx]._objectUrl;
        return `datasets/${state.datasetId}/${ds.layers[idx].filename}`;
    }
    function getLayerLabel(idx) {
        const ds = state.currentDataset;
        if (!ds) return '—';
        return ds.layers[idx]?.description || '—';
    }

    function updateImages() {
        const url1 = getLayerUrl(state.layer1Idx);
        const url2 = getLayerUrl(state.layer2Idx);

        // Compare
        const imgLeft = $('#img-left'); if (imgLeft) { imgLeft.style.opacity = 1; imgLeft.src = url1; }
        const imgRight = $('#img-right'); if (imgRight) { imgRight.style.opacity = 1; imgRight.src = url2; }
        $('#label-left').textContent = getLayerLabel(state.layer1Idx);
        $('#label-right').textContent = getLayerLabel(state.layer2Idx);

        // SxS
        const sxsL = $('#sxs-img-left'); if (sxsL) { sxsL.style.opacity = 1; sxsL.src = url1; }
        const sxsR = $('#sxs-img-right'); if (sxsR) { sxsR.style.opacity = 1; sxsR.src = url2; }
        $('#sxs-label-left').textContent = getLayerLabel(state.layer1Idx);
        $('#sxs-label-right').textContent = getLayerLabel(state.layer2Idx);

        // Alpha
        const alphaTop = $('#alpha-img-top');
        if (alphaTop) { alphaTop.style.opacity = state.alphaOpacity / 100; alphaTop.src = url1; }
        const alphaBtm = $('#alpha-img-bottom'); if (alphaBtm) { alphaBtm.style.opacity = 1; alphaBtm.src = url2; }
        $('#alpha-label-top').textContent = `Top: ${getLayerLabel(state.layer1Idx)}`;
        $('#alpha-label-btm').textContent = `Btm: ${getLayerLabel(state.layer2Idx)}`;

        // Mapper
        const mapperImg = $('#mapper-img'); if (mapperImg) { mapperImg.style.opacity = 1; mapperImg.src = url1; }

        // VI overlay canvas is no longer used — always hidden
        $('#vi-overlay-canvas')?.classList.add('hidden');
    }

    // ===========================
    //  COMPARE SLIDER
    // ===========================
    function syncCompareLeftWidth() {
        // No longer needed — compare-left-inner uses inset-0 and clip-path handles clipping
    }

    function onSliderMove(clientX) {
        const container = $('#mode-compare');
        const rect = container.getBoundingClientRect();
        let x = clientX - rect.left;
        x = Math.max(0, Math.min(x, rect.width));
        const pct = (x / rect.width) * 100;
        state.sliderPos = pct;
        $('#compare-left').style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
        $('#slider-handle').style.left = pct + '%';
    }

    // ===========================
    //  PAN & ZOOM
    // ===========================
    function applyTransform() {
        const t = state.transform;
        const style = `translate(${t.x}px, ${t.y}px) scale(${t.scale})`;
        const transition = state.isDragging ? 'none' : 'transform 0.1s ease-out';

        // Compare (apply to both image containers)
        ['#compare-right', '#compare-left-inner'].forEach(sel => {
            const el = $(sel); if (el) { el.style.transform = style; el.style.transition = transition; el.style.transformOrigin = 'center center'; }
        });
        // SxS
        ['#sxs-left-wrap', '#sxs-right-wrap'].forEach(sel => { const el = $(sel); if (el) { el.style.transform = style; el.style.transition = transition; } });
        // Alpha
        const alphaWrap = $('#alpha-wrap');
        if (alphaWrap) { alphaWrap.style.transform = style; alphaWrap.style.transition = transition; }
        // Mapper
        const mapperWrap = $('#mapper-wrap');
        if (mapperWrap) { mapperWrap.style.transform = style; mapperWrap.style.transition = transition; }

        $('#zoom-level').textContent = Math.round(t.scale * 100) + '%';
    }

    function zoom(delta) {
        const t = state.transform;
        t.scale = Math.max(0.25, Math.min(10, t.scale + delta));
        applyTransform();
    }

    // ===========================
    //  ANNOTATIONS
    // ===========================
    function renderAnnotations() {
        const ds = state.currentDataset;
        if (!ds) return;

        // Sidebar list (Data tab)
        const list = $('#annotation-list');
        list.innerHTML = '';
        if (ds.annotations.length === 0) {
            list.innerHTML = '<div class="text-center py-8 text-gray-500 text-xs border border-dashed border-gray-700 rounded"><p>No measurement points defined.</p><p class="mt-1">Use "Mapper" mode to click and add numbered points.</p></div>';
        } else {
            ds.annotations.sort((a, b) => a.index - b.index).forEach(a => {
                const div = document.createElement('div');
                div.className = 'bg-[#1a1a1a] p-3 rounded border border-gray-800 hover:border-museum-accent cursor-pointer group transition-all animate-fade-in';
                div.innerHTML = `
                    <div class="flex items-center gap-2 mb-1">
                        <div class="w-5 h-5 rounded-full bg-museum-accent text-black flex items-center justify-center text-xs font-bold">${a.index}</div>
                        <span class="text-xs font-bold text-gray-200">${a.type}</span>
                    </div>
                    <p class="text-[10px] text-gray-400 truncate pl-7">${a.description}</p>`;
                div.addEventListener('click', () => selectAnnotation(a.id));
                list.appendChild(div);
            });
        }

        // Mapper pins
        renderMapperPins();
    }

    function renderMapperPins() {
        const ds = state.currentDataset;
        const canvas = $('#mapper-canvas');
        if (!canvas || !ds) return;
        canvas.querySelectorAll('.annotation-pin').forEach(p => p.remove());

        ds.annotations.forEach(a => {
            const pin = document.createElement('div');
            pin.className = `annotation-pin ${state.selectedAnnotationId === a.id ? 'selected' : ''}`;
            pin.style.left = a.x + '%';
            pin.style.top = a.y + '%';
            pin.textContent = a.index;
            pin.addEventListener('click', (e) => { e.stopPropagation(); selectAnnotation(a.id); });
            canvas.appendChild(pin);
        });
    }

    function selectAnnotation(id) {
        state.selectedAnnotationId = id;
        const ds = state.currentDataset;
        const ann = ds.annotations.find(a => a.id === id);
        if (!ann) return;

        // Switch to Data tab
        setSidebarTab('data');

        // Show detail panel
        const detail = $('#annotation-detail');
        detail.classList.remove('hidden');
        detail.innerHTML = `
            <div class="flex justify-between items-center mb-4 border-b border-gray-700 pb-2">
                <span class="text-sm font-bold text-white flex items-center gap-2">
                    <span class="w-5 h-5 rounded-full bg-museum-accent text-black flex items-center justify-center text-xs">${ann.index}</span>
                    Point #${ann.index}
                </span>
                <button class="text-gray-300 underline text-[10px] close-detail-btn">Done</button>
            </div>
            <div class="space-y-3">
                <div>
                    <label class="block text-[10px] text-gray-500 uppercase font-bold mb-1">Type</label>
                    <p class="text-xs text-gray-200 bg-museum-800 p-2 rounded">${ann.type}</p>
                </div>
                <div>
                    <label class="block text-[10px] text-gray-500 uppercase font-bold mb-1">Observation</label>
                    <p class="text-xs text-gray-300 leading-relaxed">${ann.description}</p>
                </div>
                <div class="border-t border-gray-700 pt-3">
                    <label class="block text-[10px] text-museum-accent uppercase font-bold mb-2">Spectral / Analytical Data</label>
                    <div class="space-y-2">
                        ${ann.measurements.length === 0 ? '<p class="text-[10px] text-gray-500 italic">No spectral data attached.</p>' :
                            ann.measurements.map(m => `
                                <div class="bg-[#252525] p-2 rounded border border-gray-700">
                                    <div class="flex justify-between items-center mb-1">
                                        <span class="text-xs font-bold text-gray-300">${m.method}</span>
                                        ${m.fileName ? `<span class="text-[9px] text-museum-accent">${m.fileName}</span>` : ''}
                                    </div>
                                    <p class="text-[10px] text-gray-400">${m.result}</p>
                                    <p class="text-[9px] text-gray-500 mt-1">${m.graphData ? m.graphData.length + ' data points' : 'No graph data'}</p>
                                </div>`
                            ).join('')
                        }
                    </div>
                </div>
            </div>`;

        detail.querySelector('.close-detail-btn')?.addEventListener('click', () => {
            state.selectedAnnotationId = null;
            detail.classList.add('hidden');
            renderMapperPins();
        });

        // Update chart to show this annotation's measurements
        state.plotVisibleIds = ann.measurements.map(m => m.id);
        updateChart();
        renderPlotLegend();
        renderMapperPins();
    }

    // ===========================
    //  CHART
    // ===========================
    function initChart() {
        const ctx = $('#spectralChart').getContext('2d');
        state.spectralChart = new Chart(ctx, {
            type: 'scatter',
            data: { datasets: [] },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: { duration: 400 },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: '#1a1a1a', titleColor: '#fff', bodyColor: '#047842',
                        borderColor: '#404040', borderWidth: 1, callbacks: {
                            label: (ctx) => `λ ${ctx.parsed.x}nm → ${ctx.parsed.y.toFixed(1)}%`
                        }
                    }
                },
                scales: {
                    x: {
                        type: 'linear', grid: { color: 'rgba(255,255,255,0.05)' },
                        ticks: { color: '#9ca3af', font: { size: 9 } },
                        title: { display: true, text: 'Wavelength (nm)', color: '#6b7280', font: { size: 9 } }
                    },
                    y: {
                        type: 'linear', beginAtZero: true,
                        grid: { color: 'rgba(255,255,255,0.05)' },
                        ticks: { color: '#9ca3af', font: { size: 9 } },
                        title: { display: true, text: 'Reflectance (%)', color: '#6b7280', font: { size: 9 } }
                    }
                }
            }
        });
    }

    function updateChart() {
        const chart = state.spectralChart;
        const ds = state.currentDataset;
        if (!chart || !ds) return;

        // Collect all plotable measurements
        const datasets = [];
        let colorIdx = 0;
        ds.annotations.forEach(ann => {
            ann.measurements.forEach(m => {
                if (!state.plotVisibleIds.includes(m.id)) return;
                if (!m.graphData || m.graphData.length === 0) return;
                const color = PLOT_COLORS[colorIdx % PLOT_COLORS.length];
                datasets.push({
                    label: `Pt ${ann.index} – ${m.method}`,
                    data: m.graphData,
                    borderColor: color,
                    backgroundColor: color + '33',
                    pointBackgroundColor: color,
                    pointBorderColor: '#fff',
                    pointRadius: 2,
                    borderWidth: 2,
                    showLine: true,
                    tension: 0.3,
                    fill: false
                });
                colorIdx++;
            });
        });

        chart.data.datasets = datasets;

        // Update axis labels from inputs
        chart.options.scales.x.title.text = $('#plot-x-label')?.value || 'Wavelength (nm)';
        chart.options.scales.y.title.text = $('#plot-y-label')?.value || 'Reflectance (%)';

        chart.update();

        // Toggle empty message
        $('#chart-empty')?.classList.toggle('hidden', datasets.length > 0);
    }

    function renderPlotLegend() {
        const ds = state.currentDataset;
        const legend = $('#plot-legend');
        if (!legend || !ds) return;
        legend.innerHTML = '';
        let colorIdx = 0;
        ds.annotations.forEach(ann => {
            ann.measurements.forEach(m => {
                if (!m.graphData || m.graphData.length === 0) return;
                const color = PLOT_COLORS[colorIdx % PLOT_COLORS.length];
                const isVisible = state.plotVisibleIds.includes(m.id);
                const label = document.createElement('label');
                label.className = 'flex items-center gap-2 cursor-pointer hover:bg-gray-800 p-1 rounded';
                label.innerHTML = `
                    <input type="checkbox" ${isVisible ? 'checked' : ''} data-mid="${m.id}">
                    <div class="w-2 h-2 rounded-full flex-shrink-0" style="background:${color}"></div>
                    <span class="text-[10px] text-gray-300 truncate flex-1">Pt ${ann.index} | ${m.method}</span>`;
                label.querySelector('input').addEventListener('change', (e) => {
                    if (e.target.checked) {
                        state.plotVisibleIds.push(m.id);
                    } else {
                        state.plotVisibleIds = state.plotVisibleIds.filter(id => id !== m.id);
                    }
                    updateChart();
                });
                legend.appendChild(label);
                colorIdx++;
            });
        });
    }

    // ===========================
    //  EXPORT (Client-side)
    // ===========================
    function exportJSON() {
        const ds = state.currentDataset;
        if (!ds) return;
        const blob = new Blob([JSON.stringify(ds, null, 2)], { type: 'application/json' });
        downloadBlob(blob, `${state.datasetId}_export.json`);
    }

    function exportCSV() {
        const ds = state.currentDataset;
        if (!ds) return;
        let csv = 'sep=;\nAnnotation_Index;Type;Description;X%;Y%;Measurement_Method;Result;Wavelength;Reflectance\n';
        ds.annotations.forEach(ann => {
            if (ann.measurements.length === 0) {
                csv += `${ann.index};${ann.type};${ann.description};${ann.x};${ann.y};;;;;\n`;
            }
            ann.measurements.forEach(m => {
                if (m.graphData?.length) {
                    m.graphData.forEach(pt => {
                        csv += `${ann.index};${ann.type};${ann.description};${ann.x};${ann.y};${m.method};${m.result};${pt.x};${pt.y}\n`;
                    });
                } else {
                    csv += `${ann.index};${ann.type};${ann.description};${ann.x};${ann.y};${m.method};${m.result};;\n`;
                }
            });
        });
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        downloadBlob(blob, `${state.datasetId}_measurements.csv`);
    }

    function downloadBlob(blob, filename) {
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(link.href);
    }

    // ===========================
    //  VEGETATION INDICES ENGINE
    // ===========================
    function renderVIPanel() {
        const ds = state.currentDataset;
        if (!ds) return;

        // Parse available sub-bands from main bands (skip _isVI layers)
        const available = new Set();
        // Map band → source layer description for nm display
        const bandSource = {};
        ds.layers.forEach(l => {
            if (l._isVI) return; // skip computed VI layers
            if (!l.band) return;
            const b = l.band.toUpperCase();
            if (b === 'RGB') {
                ['RED', 'GREEN', 'BLUE'].forEach(sub => {
                    available.add(sub);
                    if (!bandSource[sub]) bandSource[sub] = l.description;
                });
            } else {
                available.add(b);
                if (!bandSource[b]) bandSource[b] = l.description;
            }
        });
        state.viAvailableBands = Array.from(available);

        // Render available band badges with nm info
        const bandsList = $('#vi-bands-list');
        bandsList.innerHTML = state.viAvailableBands.map(b => {
            const info = BAND_NM_INFO[b] || { range: '—', label: b, color: '#9ca3af' };
            const src = bandSource[b] ? ` · ${bandSource[b]}` : '';
            return `<span title="${info.label}${src}" class="inline-flex flex-col items-center bg-gray-900 border border-gray-700 rounded px-2 py-1 gap-0.5">
                <span class="text-[9px] font-bold" style="color:${info.color}">${b}</span>
                <span class="text-[8px] text-gray-400 font-mono">${info.range}</span>
            </span>`;
        }).join('');

        const container = $('#vi-cards-container');
        container.innerHTML = '';

        VI_DEFINITIONS.forEach(vi => {
            const hasAll = vi.bands.every(b => available.has(b));

            const card = document.createElement('div');
            card.className = `vi-card bg-[#1e1e1e] border ${hasAll ? 'border-emerald-900/50 hover:border-emerald-600/50 cursor-pointer' : 'border-gray-800 opacity-50'} rounded p-2 transition-colors`;

            // Band chips with nm tooltip
            const bandChips = vi.bands.map(b => {
                const info = BAND_NM_INFO[b] || { range: '—', label: b, color: '#9ca3af' };
                const ok = available.has(b);
                return `<span title="${info.label} · ${info.range}" class="text-[8px] ${ok ? 'bg-emerald-900/50 text-emerald-400 border-emerald-700' : 'bg-red-900/50 text-red-400 border-red-700'} border rounded px-1 whitespace-nowrap">${b} <span class="opacity-60">${info.range}</span></span>`;
            }).join('');

            card.innerHTML = `
                <div class="flex justify-between items-start mb-1">
                    <div>
                        <h4 class="text-[11px] font-bold ${hasAll ? 'text-emerald-400' : 'text-gray-500'}">${vi.name}</h4>
                        <p class="text-[8px] text-gray-500 font-mono">${vi.formula}</p>
                    </div>
                    <button class="vi-compute-btn bg-emerald-700 text-white text-[9px] font-bold px-2 py-0.5 rounded uppercase ${hasAll ? 'hover:bg-emerald-600' : 'hidden'}" data-vi="${vi.id}">Run</button>
                    ${!hasAll ? '<span class="text-[8px] text-red-500 font-bold uppercase bg-red-900/30 px-1 py-0.5 rounded">Missing Bands</span>' : ''}
                </div>
                <p class="text-[9px] text-gray-400 leading-tight mb-2">${vi.desc}</p>
                <div class="flex flex-wrap gap-1">${bandChips}</div>
            `;

            if (hasAll) {
                const btn = card.querySelector('.vi-compute-btn');
                btn.addEventListener('click', (e) => { e.stopPropagation(); computeVI(vi); });
                card.addEventListener('click', () => computeVI(vi));
            }

            container.appendChild(card);
        });
    }

    async function computeVI(vi) {
        const ds = state.currentDataset;
        if (!ds) return;
        
        const btn = document.querySelector(`.vi-compute-btn[data-vi="${vi.id}"]`);
        if (btn) btn.textContent = '...';

        try {
            // 1. Load images into memory
            const bandImgs = {};
            for (const layer of ds.layers) {
                if (layer.band === 'RGB') {
                    bandImgs['RED'] = layer; bandImgs['GREEN'] = layer; bandImgs['BLUE'] = layer;
                } else if (layer.band) {
                    bandImgs[layer.band.toUpperCase()] = layer;
                }
            }

            // Needed layers (unique files)
            const neededFiles = new Set(vi.bands.map(b => bandImgs[b].filename));
            const imgDataMap = {};
            let width = 0, height = 0;

            for (const fname of neededFiles) {
                const img = new Image();
                // Session: serve from ObjectURL; static: serve from datasets path
                if (ds._isSession) {
                    img.src = session.layerFiles.find(lf => lf.filename === fname)?.objectUrl || '';
                } else {
                    img.crossOrigin = 'anonymous';
                    img.src = `datasets/${state.datasetId}/${fname}`;
                }
                await new Promise((res, rej) => { img.onload = res; img.onerror = rej; });
                
                const cvs = document.createElement('canvas');
                width = img.width; height = img.height;
                cvs.width = width; cvs.height = height;
                const ctx = cvs.getContext('2d');
                ctx.drawImage(img, 0, 0);
                imgDataMap[fname] = ctx.getImageData(0, 0, width, height).data;
            }

            // 2. Compute pixel by pixel
            const resultCvs = document.createElement('canvas');
            resultCvs.width = width; resultCvs.height = height;
            const resultCtx = resultCvs.getContext('2d');
            const resultData = resultCtx.createImageData(width, height);
            
            const totalPixels = width * height;
            let sum = 0, validPixels = 0;

            for (let i = 0; i < totalPixels; i++) {
                const pxPtr = i * 4;
                const vals = {};
                
                // Extract band values
                vi.bands.forEach(b => {
                    const fname = bandImgs[b].filename;
                    const data = imgDataMap[fname];
                    if (bandImgs[b].band === 'RGB') {
                        if (b === 'RED') vals.R = data[pxPtr] / 255;
                        if (b === 'GREEN') vals.G = data[pxPtr + 1] / 255;
                        if (b === 'BLUE') vals.B = data[pxPtr + 2] / 255;
                    } else {
                        // Assuming monochrome NIR/RE is in all RGB channels, take Red channel
                        vals[b] = data[pxPtr] / 255;
                    }
                });

                // Calculate formula
                let val = 0;
                const nir = vals.NIR || 0, r = vals.RED || vals.R || 0, g = vals.GREEN || vals.G || 0, b = vals.BLUE || vals.B || 0, re = vals.RE || 0;
                
                if (vi.id === 'ndvi') val = (nir + r) === 0 ? 0 : (nir - r) / (nir + r);
                else if (vi.id === 'gndvi') val = (nir + g) === 0 ? 0 : (nir - g) / (nir + g);
                else if (vi.id === 'sr') val = r === 0 ? 0 : nir / r;
                else if (vi.id === 'ndre') val = (nir + re) === 0 ? 0 : (nir - re) / (nir + re);
                else if (vi.id === 'savi') val = (nir + r + 0.5) === 0 ? 0 : 1.5 * (nir - r) / (nir + r + 0.5);
                else if (vi.id === 'osavi') val = (nir + r + 0.16) === 0 ? 0 : 1.16 * (nir - r) / (nir + r + 0.16);
                else if (vi.id === 'msavi2') val = (2 * nir + 1 - Math.sqrt(Math.pow(2 * nir + 1, 2) - 8 * (nir - r))) / 2;
                else if (vi.id === 'tvi') val = 0.5 * (120 * (nir - g) - 200 * (r - g));
                else if (vi.id === 'evi') { const div = (nir + 6 * r - 7.5 * b + 1); val = div === 0 ? 0 : 2.5 * (nir - r) / div; }
                else if (vi.id === 'vari') { const div = (g + r - b); val = div === 0 ? 0 : (g - r) / div; }

                if (!isNaN(val) && isFinite(val)) {
                    sum += val; validPixels++;
                }
                
                // Color mapping
                // Clamp value to expected min/max for color scale
                const clampVal = Math.max(vi.min, Math.min(vi.max, val));
                // Normalize to 0-1 for colormap
                const normVal = (clampVal - vi.min) / (vi.max - vi.min);
                
                // RdYlGn colormap logic
                const [cr, cg, cb] = getHeatmapColor(normVal);
                resultData.data[pxPtr] = cr;
                resultData.data[pxPtr + 1] = cg;
                resultData.data[pxPtr + 2] = cb;
                resultData.data[pxPtr + 3] = val === 0 && (r===0 && nir===0) ? 0 : 255; // transparent if completely black source
            }

            resultCtx.putImageData(resultData, 0, 0);

            // 3. Convert result canvas → Blob → ObjectURL → real layer in ds.layers
            const viBlob = await new Promise(res => resultCvs.toBlob(res, 'image/png'));
            if (!viBlob) throw new Error('Canvas toBlob failed');

            // Revoke previous ObjectURL for this VI (if recomputed)
            const existingIdx = ds.layers.findIndex(l => l._isVI && l._viId === vi.id);
            if (existingIdx !== -1 && ds.layers[existingIdx]._objectUrl) {
                URL.revokeObjectURL(ds.layers[existingIdx]._objectUrl);
                ds.layers.splice(existingIdx, 1);
            }

            const viObjectUrl = URL.createObjectURL(viBlob);
            const viFilename = `vi_${vi.id}_${state.datasetId}.png`;
            const avg = validPixels > 0 ? (sum / validPixels).toFixed(3) : '0';

            const viLayer = {
                filename: viFilename,
                description: `[VI] ${vi.name}`,
                band: null,
                _isVI: true,
                _viId: vi.id,
                _viDef: vi,
                _objectUrl: viObjectUrl,
                _blob: viBlob,
                _stats: { avg, min: vi.min, max: vi.max, validPixels }
            };
            ds.layers.push(viLayer);
            const viLayerIdx = ds.layers.length - 1;

            // Keep track in session.viBlobs for ZIP download
            if (ds._isSession) {
                if (session.viBlobs[vi.id]?.objectUrl) URL.revokeObjectURL(session.viBlobs[vi.id].objectUrl);
                session.viBlobs[vi.id] = { blob: viBlob, filename: viFilename, objectUrl: viObjectUrl };
            }

            // 4. Update State & UI
            state.viActive = vi;

            // Re-render sidebar so new layer appears in dropdowns
            renderSidebar();

            // Auto-select the VI layer as Layer 1
            state.layer1Idx = viLayerIdx;
            $('#layer-left').value = viLayerIdx;

            $('#vi-active-info').classList.remove('hidden');
            $('#vi-active-name').textContent = vi.name;
            $('#vi-active-stats').textContent = `Avg: ${avg}  (Range: ${vi.min} → ${vi.max})`;

            const legend = $('#vi-color-legend');
            legend.classList.remove('hidden');
            $('#vi-legend-title').textContent = vi.name;
            $('#vi-legend-max').textContent = vi.max;
            $('#vi-legend-mid').textContent = ((vi.max + vi.min) / 2).toFixed(1);
            $('#vi-legend-min').textContent = vi.min;

            updateImages();

        } catch (err) {
            console.error("VI Compute Error", err);
            alert("Error computing Vegetation Index");
        } finally {
            if (btn) btn.textContent = 'Run';
        }
    }

    function clearVI() {
        const ds = state.currentDataset;
        if (ds) {
            // Revoke ObjectURLs and remove all VI layers from ds.layers
            ds.layers = ds.layers.filter(l => {
                if (l._isVI) {
                    if (l._objectUrl) URL.revokeObjectURL(l._objectUrl);
                    return false;
                }
                return true;
            });
        }
        // Clear session viBlobs references (ObjectURLs already revoked above)
        session.viBlobs = {};

        state.viActive = null;
        $('#vi-active-info').classList.add('hidden');
        $('#vi-overlay-canvas').classList.add('hidden');
        $('#vi-color-legend').classList.add('hidden');

        // Clamp indices to remaining layers
        if (ds) {
            const maxL = ds.layers.length - 1;
            if (state.layer1Idx > maxL) state.layer1Idx = Math.max(0, maxL);
            if (state.layer2Idx > maxL) state.layer2Idx = Math.max(0, maxL);
        }

        renderSidebar(); // rebuild dropdowns without VI entries
        $('#layer-left').value = state.layer1Idx;
        $('#layer-right').value = state.layer2Idx;
        updateImages();
    }

    // Color map function (RdYlGn equivalent)
    function getHeatmapColor(value) {
        // value from 0 to 1
        const colors = [
            [215, 48, 39],   // Red (0)
            [252, 141, 89],  // Orange
            [254, 224, 139], // Yellow
            [217, 239, 139], // Light Green
            [145, 207, 96],  // Green
            [26, 152, 80]    // Dark Green (1)
        ];
        
        if (value <= 0) return colors[0];
        if (value >= 1) return colors[colors.length - 1];
        
        const scaledVal = value * (colors.length - 1);
        const idx = Math.floor(scaledVal);
        const frac = scaledVal - idx;
        
        const c1 = colors[idx];
        const c2 = colors[idx + 1];
        
        return [
            Math.round(c1[0] + (c2[0] - c1[0]) * frac),
            Math.round(c1[1] + (c2[1] - c1[1]) * frac),
            Math.round(c1[2] + (c2[2] - c1[2]) * frac)
        ];
    }

    // ===========================
    //  SESSION — MODAL & CREATION
    // ===========================

    function showSessionModal() {
        // Reset pending files on each open
        _pendingFiles = [];
        $('#session-file-list').innerHTML = '';
        $('#session-title').value = '';
        $('#session-author').value = '';
        $('#session-desc').value = '';
        $('#session-date').value = new Date().toISOString().split('T')[0];
        $('#session-location').value = '';
        $('#session-files').value = '';
        $('#session-modal').classList.remove('hidden');
    }

    function hideSessionModal() {
        // Revoke any ObjectURLs created for previews that weren't committed
        if (!session.isActive) {
            _pendingFiles.forEach(pf => URL.revokeObjectURL(pf.objectUrl));
        }
        _pendingFiles = [];
        $('#session-modal').classList.add('hidden');
    }

    function renderSessionFileList() {
        const container = $('#session-file-list');
        if (!container) return;
        container.innerHTML = '';
        if (_pendingFiles.length === 0) return;

        const header = document.createElement('div');
        header.className = 'flex items-center justify-between mb-2';
        header.innerHTML = `
            <span class="text-[10px] uppercase text-gray-400 font-bold">${_pendingFiles.length} image(s) staged</span>
            <button id="clear-all-files" class="text-[9px] text-red-500 hover:text-red-400 uppercase font-bold">Clear all</button>`;
        header.querySelector('#clear-all-files').addEventListener('click', () => {
            _pendingFiles.forEach(pf => URL.revokeObjectURL(pf.objectUrl));
            _pendingFiles = [];
            renderSessionFileList();
        });
        container.appendChild(header);

        _pendingFiles.forEach((pf, i) => {
            const band = descriptionToBand(pf.description);
            const badgeClass = band
                ? 'text-emerald-400 bg-emerald-900/30 border-emerald-700'
                : 'text-gray-400 bg-gray-800 border-gray-700';

            const row = document.createElement('div');
            row.className = 'flex items-center gap-3 bg-[#1a1a1a] border border-gray-700 rounded p-2';
            row.innerHTML = `
                <div class="w-12 h-12 bg-black rounded overflow-hidden flex-shrink-0">
                    <img src="${pf.objectUrl}" class="w-full h-full object-contain" alt="${pf.filename}">
                </div>
                <div class="flex-1 min-w-0">
                    <p class="text-[11px] text-gray-300 truncate font-medium">${pf.filename}</p>
                    <div class="flex items-center gap-2 mt-1">
                        <input type="text" value="${pf.description}" placeholder="e.g. 685nm, NIR, RGB"
                            class="flex-1 bg-[#252525] border border-gray-700 text-gray-300 text-[11px] p-1 rounded focus:border-museum-accent focus:outline-none band-desc-input">
                        <span class="text-[9px] font-bold px-1.5 py-0.5 rounded border flex-shrink-0 band-badge ${badgeClass}">${band || '?'}</span>
                    </div>
                </div>
                <button class="text-gray-500 hover:text-red-400 flex-shrink-0 p-1 remove-file-btn">
                    <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
                </button>`;

            // Band input live update
            row.querySelector('.band-desc-input').addEventListener('input', e => {
                _pendingFiles[i].description = e.target.value;
                const newBand = descriptionToBand(e.target.value);
                _pendingFiles[i].band = newBand;
                const badge = row.querySelector('.band-badge');
                badge.textContent = newBand || '?';
                badge.className = `text-[9px] font-bold px-1.5 py-0.5 rounded border flex-shrink-0 band-badge ${
                    newBand ? 'text-emerald-400 bg-emerald-900/30 border-emerald-700' : 'text-gray-400 bg-gray-800 border-gray-700'}`;
            });

            // Remove button
            row.querySelector('.remove-file-btn').addEventListener('click', () => {
                URL.revokeObjectURL(_pendingFiles[i].objectUrl);
                _pendingFiles.splice(i, 1);
                renderSessionFileList();
            });

            container.appendChild(row);
        });
    }

    function onSessionFilesSelected(fileList) {
        for (const file of fileList) {
            if (_pendingFiles.some(pf => pf.filename === file.name)) continue; // skip duplicates
            const objectUrl = URL.createObjectURL(file);
            const nameNoExt = file.name.replace(/\.[^.]+$/, '');
            const band = descriptionToBand(nameNoExt);
            _pendingFiles.push({ file, objectUrl, filename: file.name, description: nameNoExt, band });
        }
        renderSessionFileList();
    }

    async function createSession() {
        if (_pendingFiles.length === 0) {
            alert('Select at least one image before creating the session.');
            return;
        }

        const titleVal = $('#session-title').value.trim() || 'Untitled Session';
        const authorVal = $('#session-author').value.trim() || 'Student';
        const descVal = $('#session-desc').value.trim() || '';
        const dateVal = $('#session-date').value || new Date().toISOString().split('T')[0];
        const locVal = $('#session-location').value.trim() || '—';

        // Commit pending files into session
        session.isActive = true;
        session.id = 'sess_' + Date.now().toString(36);
        session.layerFiles = _pendingFiles.map(pf => ({ ...pf }));
        session.viBlobs = {};
        _pendingFiles = [];

        const layers = session.layerFiles.map(lf => ({
            filename: lf.filename,
            description: lf.description,
            band: lf.band || null,
            _objectUrl: lf.objectUrl,
            _isSession: true
        }));

        state.currentDataset = {
            _isSession: true,
            metadata: {
                title: titleVal, author: authorVal, description: descVal,
                date: dateVal, coordinates: locVal,
                sensor: 'User Upload (Browser Session)',
                year: dateVal.split('-')[0] || '—'
            },
            layers,
            annotations: []
        };
        state.datasetId = session.id;
        state.layer1Idx = 0;
        state.layer2Idx = Math.min(1, layers.length - 1);
        state.selectedAnnotationId = null;
        state.transform = { scale: 1, x: 0, y: 0 };
        state.sliderPos = 50;
        state.plotVisibleIds = [];
        state.viActive = null;

        hideSessionModal();
        showView('analysis');
        renderSidebar();
        setMode('compare');
        applyTransform();
        $('#compare-left').style.clipPath = 'inset(0 50% 0 0)';
        $('#slider-handle').style.left = '50%';
        renderAnnotations();
        updateChart();
    }

    // ===========================
    //  SESSION — UI HELPERS
    // ===========================

    function updateSessionExportUI() {
        const isSession = !!(state.currentDataset?._isSession);
        $('#session-zip-btn')?.classList.toggle('hidden', !isSession);
        $('#session-zip-info')?.classList.toggle('hidden', !isSession);
        $('#session-export-sep')?.classList.toggle('hidden', !isSession);
    }

    // ===========================
    //  SESSION — ZIP DOWNLOAD
    // ===========================

    async function downloadSessionZip() {
        const ds = state.currentDataset;
        if (!ds || !ds._isSession) { exportJSON(); return; }
        if (typeof JSZip === 'undefined') { alert('JSZip not loaded.'); return; }

        const btn = $('#session-zip-btn');
        const origText = btn?.innerHTML;
        if (btn) { btn.textContent = 'Building ZIP…'; btn.disabled = true; }

        try {
            const zip = new JSZip();
            const safeTitle = (ds.metadata.title || session.id).replace(/[^a-zA-Z0-9_-]/g, '_');
            const folder = zip.folder(safeTitle);

            // 1. Original uploaded images
            for (const lf of session.layerFiles) {
                folder.file(lf.filename, lf.file);
            }

            // 2. VI result PNGs (from _blob on each VI layer in ds.layers)
            const viLayers = ds.layers.filter(l => l._isVI && l._blob);
            for (const vl of viLayers) {
                folder.file(vl.filename, vl._blob);
            }

            // 3. Project JSON (compatible with the web-app format)
            const allLayers = [
                ...ds.layers.filter(l => !l._isVI).map(l => ({
                    filename: l.filename,
                    description: l.description,
                    band: l.band || null,
                    type: 'User Upload'
                })),
                ...viLayers.map(vl => ({
                    filename: vl.filename,
                    description: vl.description,
                    band: null,
                    type: `VI_${vl._viId}`
                }))
            ];

            const projJSON = {
                id: session.id,
                metadata: { ...ds.metadata },
                layers: allLayers,
                annotations: ds.annotations,
                timestamp: new Date().toISOString()
            };
            folder.file(`${session.id}.json`, JSON.stringify(projJSON, null, 2));

            // 4. README for the student
            const readmeLines = [
                `# ${ds.metadata.title}`,
                `Author: ${ds.metadata.author}`,
                `Date: ${ds.metadata.date}`,
                `Site: ${ds.metadata.coordinates}`,
                '',
                '## Contents',
                ...allLayers.map(l => `- ${l.filename}  [${l.description}]`),
                '',
                '## Notes',
                ds.metadata.description || '',
                '',
                'Generated by FieldSpectralView-Lite — https://github.com/DumitruScutelnic/FieldSpectralView-Lite'
            ];
            folder.file('README.md', readmeLines.join('\n'));

            // Generate and download
            const blob = await zip.generateAsync({
                type: 'blob',
                compression: 'DEFLATE',
                compressionOptions: { level: 4 }
            });
            downloadBlob(blob, `${safeTitle}.zip`);

        } catch (err) {
            console.error('ZIP error', err);
            alert('Error building ZIP: ' + err.message);
        } finally {
            if (btn) { btn.innerHTML = origText; btn.disabled = false; }
        }
    }

    // ===========================
    //  EVENT BINDINGS
    // ===========================
    function bindEvents() {
        // Navigation
        $('#nav-archive').addEventListener('click', () => showView('archive'));
        $('#nav-analysis').addEventListener('click', () => { if (state.currentDataset) showView('analysis'); });
        $('#btn-back').addEventListener('click', () => showView('archive'));
        $('#logo-click').addEventListener('click', () => showView('archive'));

        // --- Session modal ---
        $('#btn-new-session')?.addEventListener('click', showSessionModal);
        $('#session-close-btn')?.addEventListener('click', hideSessionModal);
        $('#session-cancel-btn')?.addEventListener('click', hideSessionModal);
        $('#session-modal-bg')?.addEventListener('click', hideSessionModal);
        $('#session-create-btn')?.addEventListener('click', createSession);
        $('#session-zip-btn')?.addEventListener('click', downloadSessionZip);

        // File input (click to select)
        $('#session-files')?.addEventListener('change', e => onSessionFilesSelected(e.target.files));

        // Drag & drop on the drop zone
        const dropZone = $('#session-drop-zone');
        if (dropZone) {
            dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('border-museum-accent', 'bg-museum-accent/5'); });
            dropZone.addEventListener('dragleave', () => dropZone.classList.remove('border-museum-accent', 'bg-museum-accent/5'));
            dropZone.addEventListener('drop', e => {
                e.preventDefault();
                dropZone.classList.remove('border-museum-accent', 'bg-museum-accent/5');
                onSessionFilesSelected(e.dataTransfer.files);
            });
        }

        // Keyboard: Escape closes session modal
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape' && !$('#session-modal').classList.contains('hidden')) {
                hideSessionModal();
            }
        });

        // Sidebar tabs
        $$('.sidebar-tab').forEach(t => t.addEventListener('click', () => setSidebarTab(t.dataset.tab)));

        // Sidebar toggle
        $('#btn-toggle-sidebar').addEventListener('click', () => {
            state.sidebarOpen = !state.sidebarOpen;
            const sidebar = $('#sidebar');
            sidebar.style.width = state.sidebarOpen ? '24rem' : '0px';
            sidebar.style.overflow = state.sidebarOpen ? '' : 'hidden';
            $('#sidebar-icon-close').classList.toggle('hidden', !state.sidebarOpen);
            $('#sidebar-icon-open').classList.toggle('hidden', state.sidebarOpen);
        });

        // Mode buttons
        $$('.mode-btn').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));

        // Layer selectors
        $('#layer-left').addEventListener('change', (e) => { state.layer1Idx = parseInt(e.target.value); updateImages(); updateStatusBar(); });
        $('#layer-right').addEventListener('change', (e) => { state.layer2Idx = parseInt(e.target.value); updateImages(); updateStatusBar(); });

        // Alpha slider
        $('#alpha-slider').addEventListener('input', (e) => {
            state.alphaOpacity = parseInt(e.target.value);
            $('#alpha-value').textContent = state.alphaOpacity + '%';
            $('#alpha-img-top').style.opacity = state.alphaOpacity / 100;
        });

        // VI Section Toggles
        $('#vi-section-toggle').addEventListener('click', () => {
            $('#vi-bands-available').classList.toggle('hidden');
            $('#vi-cards-container').classList.toggle('hidden');
            $('#vi-toggle-icon').style.transform = $('#vi-cards-container').classList.contains('hidden') ? 'rotate(0deg)' : 'rotate(180deg)';
        });

        $('#vi-clear-btn').addEventListener('click', clearVI);

        // Mapper tools
        $$('.tool-btn').forEach(b => b.addEventListener('click', () => {
            state.activeTool = b.dataset.tool;
            $$('.tool-btn').forEach(t => t.classList.toggle('active', t.dataset.tool === state.activeTool));
            updateStatusBar();
        }));

        // --- Compare slider drag ---
        const sliderHandle = $('#slider-handle');
        const compareEl = $('#mode-compare');

        sliderHandle.addEventListener('mousedown', (e) => { state.isSliderDragging = true; e.preventDefault(); });
        sliderHandle.addEventListener('touchstart', (e) => { state.isSliderDragging = true; e.preventDefault(); });

        document.addEventListener('mouseup', () => { state.isSliderDragging = false; state.isDragging = false; });
        document.addEventListener('touchend', () => { state.isSliderDragging = false; state.isDragging = false; });

        document.addEventListener('mousemove', (e) => {
            if (state.isSliderDragging) { onSliderMove(e.clientX); return; }
            if (state.isDragging) {
                state.transform.x += e.clientX - state.dragStart.x;
                state.transform.y += e.clientY - state.dragStart.y;
                state.dragStart = { x: e.clientX, y: e.clientY };
                applyTransform();
            }
        });
        document.addEventListener('touchmove', (e) => {
            if (state.isSliderDragging) { onSliderMove(e.touches[0].clientX); return; }
        });

        // Allow clicking anywhere on compare to move slider (except shift+click = pan)
        compareEl.addEventListener('mousedown', (e) => {
            if (e.shiftKey) return;  // shift+drag = pan, not slider
            if (!e.target.closest('#slider-handle')) {
                state.isSliderDragging = true;
                onSliderMove(e.clientX);
            }
        });

        // --- Pan (all modes) ---
        const viewerArea = $('#viewer-area');
        viewerArea.addEventListener('mousedown', (e) => {
            if (state.mode === 'mapper' && state.activeTool === 'marker') return;
            // In compare mode, only allow pan if not clicking the slider area
            if (state.mode === 'compare' && !e.shiftKey) return;
            state.isDragging = true;
            state.dragStart = { x: e.clientX, y: e.clientY };
        });

        // --- Zoom (wheel — all modes) ---
        viewerArea.addEventListener('wheel', (e) => {
            e.preventDefault();
            zoom(e.deltaY > 0 ? -0.1 : 0.1);
        }, { passive: false });

        // Zoom buttons
        $('#zoom-in').addEventListener('click', () => zoom(0.15));
        $('#zoom-out').addEventListener('click', () => zoom(-0.15));
        $('#zoom-reset').addEventListener('click', () => {
            state.transform = { scale: 1, x: 0, y: 0 };
            applyTransform();
        });

        // --- Mapper click (add annotation) ---
        $('#mapper-canvas').addEventListener('click', (e) => {
            if (state.mode !== 'mapper' || state.activeTool !== 'marker') return;
            if (e.target.closest('.annotation-pin')) return;

            const canvas = $('#mapper-canvas');
            const rect = canvas.getBoundingClientRect();
            const xPct = ((e.clientX - rect.left) / rect.width) * 100;
            const yPct = ((e.clientY - rect.top) / rect.height) * 100;

            const ds = state.currentDataset;
            const newIdx = ds.annotations.length + 1;
            const newAnn = {
                id: 'ann_new_' + Date.now(),
                index: newIdx,
                x: parseFloat(xPct.toFixed(1)),
                y: parseFloat(yPct.toFixed(1)),
                type: 'Sampling Point',
                description: 'New observation point',
                layerContext: ds.layers[state.layer1Idx]?.description || '',
                measurements: []
            };
            ds.annotations.push(newAnn);
            renderAnnotations();
            selectAnnotation(newAnn.id);
        });

        // Export
        $('#btn-export-json').addEventListener('click', exportJSON);
        $('#export-json-btn').addEventListener('click', exportJSON);
        $('#export-csv-btn').addEventListener('click', exportCSV);

        // Axis label changes
        $('#plot-x-label')?.addEventListener('change', updateChart);
        $('#plot-y-label')?.addEventListener('change', updateChart);

        // Window resize (kept for future use)
        window.addEventListener('resize', () => { /* reserved */ });
    }

    // ===========================
    //  UI NOTIFICATIONS
    // ===========================
    function showFileProtocolWarning() {
        const grid = $('#archive-grid');
        grid.innerHTML = `
            <div class="col-span-3 bg-red-900/20 border border-red-500/50 p-8 rounded-xl text-center">
                <div class="w-16 h-16 bg-red-500/20 rounded-full flex items-center justify-center mx-auto mb-6">
                    <svg class="w-8 h-8 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
                    </svg>
                </div>
                <h2 class="text-xl font-bold text-white mb-2">Protocollo file:// non supportato</h2>
                <p class="text-gray-300 max-w-md mx-auto mb-6">
                    I browser moderni bloccano il caricamento dei dati quando il sito viene aperto tramite "doppio click" sul file.
                </p>
                <div class="bg-black/40 p-4 rounded-lg text-left inline-block">
                    <p class="text-xs font-bold text-museum-accent uppercase mb-2">Soluzione Rapida:</p>
                    <ol class="text-sm text-gray-400 space-y-2 list-decimal list-inside">
                        <li>Usa l'estensione <b>Live Server</b> di VS Code</li>
                        <li>Oppure usa il comando: <code class="bg-gray-800 px-1 rounded">python3 -m http.server</code></li>
                    </ol>
                </div>
            </div>`;
        
        const ls = $('#loading-screen');
        ls.style.opacity = '0';
        setTimeout(() => ls.style.display = 'none', 500);
    }

    // ===========================
    //  INIT
    // ===========================
    async function init() {
        bindEvents();
        initChart();
        setSidebarTab('layers');
        await renderArchive();

        // Hide loading screen
        setTimeout(() => {
            const ls = $('#loading-screen');
            ls.style.opacity = '0';
            setTimeout(() => ls.style.display = 'none', 500);
        }, 600);
    }

    document.addEventListener('DOMContentLoaded', init);
})();
