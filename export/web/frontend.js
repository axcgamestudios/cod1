/**
 * Frontend shell: the loading screen, title screen, pause menu, and class
 * picker.
 *
 * The art comes from `zone/all/ui_mp.ff` via `.tools/export_ui.py`, layered in
 * the order the original `menu,main` linked it (backdrop, scrolling fog, glow,
 * logo plate). The layout is not the game's -- T6 menudefs do not dump -- so
 * the screens here are rebuilt around what this viewer actually has.
 *
 * The state machine is deliberately free of DOM access so it can be tested in
 * node; `elements` is optional and every write goes through `render()`.
 */

// Loader labels are internal asset names; the caption shows something a
// player can read. Unmapped labels fall through unchanged.
const CAPTIONS = {
  map: 'map geometry',
  textures: 'map textures',
  render: 'map scene',
  collision: 'collision',
  navigation: 'navigation mesh',
  shaders: 'compiling shaders',
  hands: 'viewhands',
  weapon: 'weapon',
  magazine: 'magazine',
  enemy: 'enemy body',
  'enemy weapon': 'enemy weapon',
};

export const SCREENS = ['welcome', 'mode', 'loading', 'title', 'pause', 'class', 'lobby', 'settings', 'error'];

// The controls the settings screen offers remaps, with their default keys.
// Order is the order the screen shows them in.
export const BINDABLE_ACTIONS = Object.freeze([
  { id: 'forward', label: 'Move forward', code: 'KeyW' },
  { id: 'back', label: 'Move back', code: 'KeyS' },
  { id: 'left', label: 'Strafe left', code: 'KeyA' },
  { id: 'right', label: 'Strafe right', code: 'KeyD' },
  { id: 'sprint', label: 'Sprint', code: 'ShiftLeft' },
  { id: 'jump', label: 'Jump', code: 'Space' },
  { id: 'crouch', label: 'Crouch', code: 'KeyC' },
  { id: 'reload', label: 'Reload', code: 'KeyR' },
  // Aim is remappable like every other action: mouse buttons are stored as
  // "Mouse0/1/2" codes so the trigger, wheel and side buttons all work.
  { id: 'aim', label: 'Aim down sights', code: 'Mouse2' },
  { id: 'melee', label: 'Melee', code: 'KeyE' },
  { id: 'frag', label: 'Frag grenade', code: 'KeyG' },
  { id: 'smoke', label: 'Smoke grenade', code: 'KeyQ' },
  { id: 'switch1', label: 'Primary weapon', code: 'Digit1' },
  { id: 'switch2', label: 'Secondary weapon', code: 'Digit2' },
  { id: 'camo', label: 'Cycle camo', code: 'KeyK' },
  { id: 'respawn', label: 'Respawn', code: 'KeyB' },
]);

export class Frontend {
  constructor({
    elements = null, onPlay = null, onResume = null, onSelectWeapon = null, onSelectLoadout = null, onOpenClass = null,
    onChooseMode = null, onOpenLobby = null, onCloseLobby = null, waitingForInput = false,
  } = {}) {
    this.elements = elements;
    this.onPlay = onPlay;
    this.onResume = onResume;
    this.onSelectWeapon = onSelectWeapon;
    // Fired with the whole {primary, secondary, ...} loadout on confirm; the
    // per-weapon onSelectWeapon still fires for the primary, for older callers.
    this.onSelectLoadout = onSelectLoadout;
    // Fired when the class screen opens so the game can fetch the rifles it
    // has not loaded yet. Only a player who browses classes pays for them.
    this.onOpenClass = onOpenClass;
    // Fired when the player commits to singleplayer or multiplayer; the host
    // page wires this to the deferred heavy load, which needs the mode to
    // know whether bots belong in the match.
    this.onChooseMode = onChooseMode;
    this.onOpenLobby = onOpenLobby;
    this.onCloseLobby = onCloseLobby;

    this.screen = waitingForInput ? 'welcome' : 'loading';
    this.mode = 'single';
    this.playing = false;
    this.loads = new Map();
    this.expected = new Map();
    this.finished = new Set();
    this.complete = false;
    this.peak = 0;
    this.message = '';
    this.controls = [];
    this.weaponOptions = [];
    // Create-a-class is tabbed like the game's: one tab per weapon class and
    // one selection per tab. `selectedWeapon` stays the primary's id.
    this.classes = [{ id: 'primary', label: 'Primary', hint: '' }];
    this.activeClass = 'primary';
    this.loadout = {};
    this.classReturnScreen = 'title';

    this.bindElements();
    this.render();
  }

  /** True while the shell covers the game. */
  get visible() {
    return !this.playing;
  }

  get ready() {
    return this.screen === 'title' || this.screen === 'pause';
  }

  /** The first visitor gesture opens the mode picker; waiting is not download progress. */
  showMode() {
    this.screen = 'mode';
    this.render();
    return true;
  }

  /** The first visitor gesture starts loading; waiting is not download progress. */
  startLoading() {
    if (this.screen !== 'welcome' && this.screen !== 'mode') return false;
    this.screen = 'loading';
    this.render();
    return true;
  }

  /** Commit to singleplayer or multiplayer; begins the load through the host. */
  chooseMode(mode) {
    if (this.screen !== 'mode') return false;
    this.mode = mode === 'multi' ? 'multi' : 'single';
    this.startLoading();
    this.onChooseMode?.(this.mode);
    return true;
  }

  /**
   * Declare the stages the load will run and their relative weight, keyed by
   * the same labels `progress()` receives.
   *
   * Byte totals alone cannot measure this load. GLTFLoader reports progress
   * for the .gltf JSON only -- neither the 44 MB buffer it references nor the
   * 59 MB of textures behind it reaches a callback -- so a pure byte bar fills
   * on a small fraction of the payload and then sits full. Fixed stage weights
   * give a denominator known from the first frame, and `stage()` is what
   * actually completes one.
   */
  expect(weights) {
    for (const [label, weight] of Object.entries(weights ?? {})) {
      if (Number(weight) > 0) this.expected.set(label, Number(weight));
    }
    this.render();
  }

  /** Mark a declared stage finished, whatever its bytes said. */
  stage(label) {
    if (!this.expected.has(label)) return false;
    this.finished.add(label);
    this.render();
    return true;
  }

  /** How far a stage's own byte reports have got it, 0..1. */
  stageBytes(label) {
    const entry = this.loads.get(label);
    if (!entry?.total) return 0;
    return Math.min(1, entry.loaded / entry.total);
  }

  /** Overall load fraction, 0..1. */
  get fraction() {
    if (this.complete) return 1;

    if (this.expected.size) {
      let value = 0;
      let total = 0;
      for (const [label, weight] of this.expected) {
        total += weight;
        // An unfinished stage is held short of its full weight however
        // encouraging its byte count looks, so the bar cannot claim a stage
        // whose unreported buffer is still in flight.
        value += weight * (this.finished.has(label) ? 1 : Math.min(0.9, this.stageBytes(label)));
      }
      return total ? value / total : 0;
    }

    // Undeclared fallback: loads register as they start, so the denominator
    // grows and a raw ratio can walk backwards. Hold the high-water mark.
    let loaded = 0;
    let total = 0;
    for (const entry of this.loads.values()) {
      if (!entry.total) continue;
      loaded += Math.min(entry.loaded, entry.total);
      total += entry.total;
    }
    if (total > 0) this.peak = Math.max(this.peak, loaded / total);
    return this.peak;
  }

  /**
   * True once something has reported a byte total to measure against. A host
   * serving chunked or gzipped responses sends no Content-Length, so there is
   * nothing to take a percentage of and the bar has to run indeterminate.
   */
  get determinate() {
    if (this.expected.size) return true;
    for (const entry of this.loads.values()) {
      if (entry.total) return true;
    }
    return false;
  }

  get loadedBytes() {
    let loaded = 0;
    for (const entry of this.loads.values()) loaded += entry.loaded;
    return loaded;
  }

  /**
   * What to name in the status line: the first stage still outstanding, or --
   * with no stages declared -- whichever source has the most work left.
   */
  get caption() {
    // Declared stages are named in declaration order rather than by bytes
    // outstanding: the map reports its .gltf complete long before its buffer
    // arrives, so byte counts would move the caption on while the biggest
    // download is still running.
    if (this.expected.size) {
      for (const label of this.expected.keys()) {
        if (!this.finished.has(label)) return CAPTIONS[label] ?? label;
      }
      return 'finishing up';
    }

    const determinate = this.determinate;
    let worst = null;
    let score = 0;
    for (const [label, entry] of this.loads) {
      // Once anything reports a total, sources that do not report one would
      // otherwise win on raw bytes and mislabel the bar.
      if (determinate && !entry.total) continue;
      const value = entry.total
        ? entry.total - Math.min(entry.loaded, entry.total)
        : entry.loaded;
      if (value > score) {
        score = value;
        worst = label;
      }
    }
    if (!worst) return this.loads.size ? 'finishing up' : 'connecting';
    return CAPTIONS[worst] ?? worst;
  }

  progress(label, event = {}) {
    if (this.screen !== 'loading') return;
    const loaded = Number(event.loaded) || 0;
    const total = Number(event.total) || 0;
    const entry = this.loads.get(label) ?? { loaded: 0, total: 0 };
    entry.loaded = Math.max(entry.loaded, loaded);
    entry.total = Math.max(entry.total, total);
    this.loads.set(label, entry);
    this.render();
  }

  /** Loading finished; show the title screen and wait for a key or a click. */
  setReady(controls = []) {
    if (this.screen === 'error') return;
    this.controls = controls.filter(Boolean);
    this.complete = true;
    this.screen = 'title';
    this.render();
  }

  /** The tabs the class screen shows, in order. */
  setClasses(classes = []) {
    const list = (classes ?? []).map((cls) => (typeof cls === 'string' ? { id: cls } : cls ?? {}))
      .filter((cls) => cls.id)
      .map((cls) => ({ id: String(cls.id), label: cls.label ?? cls.id, hint: cls.hint ?? '' }));
    this.classes = list.length ? list : [{ id: 'primary', label: 'Primary', hint: '' }];
    if (!this.classes.some((cls) => cls.id === this.activeClass)) this.activeClass = this.classes[0].id;
    this.render();
    return this.classes.map((cls) => cls.id);
  }

  /** Show one tab; the cards of the other classes hide. */
  showClassTab(classId) {
    const cls = this.classes.find((entry) => entry.id === String(classId));
    if (!cls) return false;
    this.activeClass = cls.id;
    this.render();
    return this.activeClass;
  }

  /** The primary's id, for callers that predate the tabs. */
  get selectedWeapon() {
    return this.loadout.primary ?? null;
  }

  set selectedWeapon(id) {
    this.loadout.primary = id ?? null;
  }

  /**
   * Supply the compact card data used by the class screen. Each option names
   * its class (default primary); `selected` may be one id (the primary) or a
   * whole loadout object keyed by class.
   */
  setWeapons(weapons = [], selected = null) {
    this.weaponOptions = (weapons ?? []).map((weapon) => {
      const entry = typeof weapon === 'string' ? { id: weapon } : weapon ?? {};
      return {
        ...entry,
        id: String(entry.id ?? '').toLowerCase(),
        class: String(entry.class ?? 'primary'),
        ready: entry.ready !== false,
      };
    }).filter((weapon) => weapon.id);

    const requested = selected && typeof selected === 'object'
      ? selected
      : { ...this.loadout, ...(selected == null ? {} : { primary: String(selected).toLowerCase() }) };
    const classIds = new Set([...this.classes.map((cls) => cls.id), ...this.weaponOptions.map((weapon) => weapon.class)]);
    const loadout = {};
    for (const classId of classIds) {
      const options = this.weaponOptions.filter((weapon) => weapon.class === classId);
      if (!options.length) continue;
      const wanted = String(requested?.[classId] ?? '').toLowerCase();
      loadout[classId] = (options.find((weapon) => weapon.id === wanted) ?? options[0]).id;
    }
    this.loadout = loadout;
    this.render();
    return this.weaponOptions.map((weapon) => ({ id: weapon.id, class: weapon.class, ready: weapon.ready }));
  }

  /** Update one card's load state without exposing the viewmodel object. */
  setWeaponReady(id, ready = true) {
    const normalized = String(id ?? '').toLowerCase();
    const option = this.weaponOptions.find((weapon) => weapon.id === normalized);
    if (!option) return false;
    option.ready = Boolean(ready);
    this.render();
    return option.ready;
  }

  /** Open the create-a-class screen from title or pause. */
  openClass() {
    if (this.screen !== 'title' && this.screen !== 'pause') return false;
    this.classReturnScreen = this.screen;
    this.screen = 'class';
    this.playing = false;
    // The rifles other than the equipped one are only fetched from here, so
    // opening the screen is what starts them. Cards report `loading` until
    // each one calls back through setWeaponReady().
    this.onOpenClass?.();
    this.render();
    return true;
  }

  // Alias reads naturally for callers that describe the screen as a view.
  showClass() {
    return this.openClass();
  }

  /** Return to whichever shell screen opened the class picker. */
  closeClass() {
    if (this.screen !== 'class') return false;
    this.screen = this.classReturnScreen === 'pause' ? 'pause' : 'title';
    this.playing = false;
    this.render();
    return this.screen;
  }

  /** Select a loaded card into its class's slot; unloaded cards stay unavailable. */
  chooseWeapon(id) {
    if (this.screen !== 'class') return false;
    const normalized = String(id ?? '').toLowerCase();
    const option = this.weaponOptions.find((weapon) => weapon.id === normalized);
    if (!option || !option.ready) return false;
    this.loadout[option.class] = option.id;
    this.activeClass = this.classes.some((cls) => cls.id === option.class) ? option.class : this.activeClass;
    this.render();
    return option.id;
  }

  /** Confirm the loadout through the game-side selectors, then return to shell. */
  confirmClass() {
    if (this.screen !== 'class') return false;
    const primary = this.weaponOptions.find((weapon) => weapon.id === this.loadout.primary);
    if (!primary?.ready) return false;
    for (const [classId, id] of Object.entries(this.loadout)) {
      const option = this.weaponOptions.find((weapon) => weapon.id === id);
      if (option && !option.ready) return false;
      if (!option) delete this.loadout[classId];
    }
    const loadoutResult = this.onSelectLoadout?.({ ...this.loadout });
    if (loadoutResult === false) return false;
    const result = this.onSelectWeapon?.(primary.id);
    if (result === false) return false;
    const selected = primary.id;
    this.closeClass();
    return result ?? selected;
  }

  fail(message) {
    this.screen = 'error';
    this.playing = false;
    this.message = String(message ?? 'Unable to start');
    this.render();
  }

  /**
   * Ask to start or resume. The shell deliberately stays up until the game
   * confirms with `enter()`: a pointer lock request can be refused, and a
   * hidden shell with no lock would leave nothing on screen to click.
   */
  play() {
    if (!this.ready) return false;
    if (this.screen === 'pause') this.onResume?.();
    else if (this.mode === 'multi' && this.screen === 'title') this.openLobby();
    else this.onPlay?.();
    return true;
  }

  /** Pointer lock was acquired, or automation took over. Drop the shell. */
  enter() {
    this.playing = true;
    this.render();
    return true;
  }

  /** Called when the game gives up pointer lock, by Esc or otherwise. */
  suspend() {
    if (!this.playing) return false;
    // The shell may have been entered from the lobby (multiplayer deploy), so
    // the ready getter no longer describes where play can resume from. Any
    // drop of the lock lands on the pause screen, which always can.
    this.playing = false;
    this.screen = 'pause';
    this.render();
    return true;
  }

  /** Compact, serializable view for the debug API and smoke tests. */
  getState() {
    return {
      screen: this.screen,
      mode: this.mode,
      visible: this.visible,
      percent: Math.round(this.fraction * 100),
      caption: this.screen === 'loading' ? this.caption : '',
      selectedWeapon: this.selectedWeapon,
      activeClass: this.activeClass,
      loadout: { ...this.loadout },
    };
  }

  // ---------- DOM ----------

  bindElements() {
    const el = this.elements;
    if (!el) return;
    // A click anywhere on the shell starts or resumes, matching the title
    // prompt. Buttons stop the event so they do not also trigger it.
    el.root?.addEventListener('click', () => this.play());
    for (const button of el.buttons ?? []) {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        this.action(button.dataset.action);
      });
    }
    for (const card of el.classCards ?? []) {
      card.addEventListener('click', (event) => {
        event.stopPropagation();
        this.chooseWeapon(card.dataset.weaponId);
      });
    }
    for (const tab of el.classTabs ?? []) {
      tab.addEventListener('click', (event) => {
        event.stopPropagation();
        this.showClassTab(tab.dataset.weaponClass);
      });
    }
  }

  /** Cards are built by the page from the registry; register them after the fact. */
  bindClassCards(cards = [], tabs = []) {
    if (!this.elements) return;
    this.elements.classCards = cards;
    this.elements.classTabs = tabs;
    for (const card of cards) {
      card.addEventListener('click', (event) => {
        event.stopPropagation();
        this.chooseWeapon(card.dataset.weaponId);
      });
    }
    for (const tab of tabs) {
      tab.addEventListener('click', (event) => {
        event.stopPropagation();
        this.showClassTab(tab.dataset.weaponClass);
      });
    }
    this.render();
  }

  /** Multiplayer rooms live between the title screen and the lobby. */
  openLobby() {
    if (this.screen !== 'title' || this.mode !== 'multi') return false;
    this.screen = 'lobby';
    this.playing = false;
    this.onOpenLobby?.();
    this.render();
    return true;
  }

  closeLobby() {
    if (this.screen !== 'lobby') return false;
    this.screen = 'title';
    this.playing = false;
    this.onCloseLobby?.();
    this.render();
    return this.screen;
  }

  /** Settings can be reached from every resting screen of the shell. */
  openSettings() {
    if (this.screen !== 'title' && this.screen !== 'pause' && this.screen !== 'mode') return false;
    this.settingsReturnScreen = this.screen;
    this.screen = 'settings';
    this.playing = false;
    this.render();
    return true;
  }

  closeSettings() {
    if (this.screen !== 'settings') return false;
    this.screen = this.settingsReturnScreen === 'pause' ? 'pause' : this.settingsReturnScreen === 'mode' ? 'mode' : 'title';
    this.playing = false;
    this.render();
    return this.screen;
  }

  /** Shell buttons, including class navigation and card confirmation. */
  action(name) {
    if (name === 'resume') return this.play();
    if (name === 'class') return this.openClass();
    if (name === 'class-back') return this.closeClass();
    if (name === 'class-confirm') return this.confirmClass();
    if (name === 'mode-single') return this.chooseMode('single');
    if (name === 'mode-multi') return this.chooseMode('multi');
    if (name === 'lobby-back') { this.closeLobby(); return true; }
    if (name === 'settings') return this.openSettings();
    if (name === 'settings-back') return this.closeSettings();
    return this.elements?.onAction?.(name);
  }

  render() {
    const el = this.elements;
    if (!el) return;
    const loading = this.screen === 'loading';
    const determinate = !loading || this.determinate;

    if (el.root) {
      el.root.dataset.screen = this.screen;
      el.root.dataset.determinate = String(determinate);
      el.root.style.display = this.visible ? 'flex' : 'none';
      el.root.classList.toggle('ready', this.ready);
    }
    // An indeterminate bar is left to the stylesheet to sweep, so clear the
    // inline width rather than pinning it to a percentage that means nothing.
    if (el.bar) el.bar.style.width = determinate ? `${(this.fraction * 100).toFixed(1)}%` : '';
    if (el.percent) {
      el.percent.textContent = !loading ? ''
        : determinate ? `${Math.round(this.fraction * 100)}%`
        : `${(this.loadedBytes / 1048576).toFixed(1)} MB`;
    }
    if (el.caption) el.caption.textContent = loading ? `${this.caption}…` : '';
    if (el.message) el.message.textContent = this.message;
    if (el.controls && this.controls.length) el.controls.textContent = this.controls.join('\n');
    for (const card of el.classCards ?? []) {
      const option = this.weaponOptions.find((weapon) => weapon.id === card.dataset.weaponId);
      const classId = option?.class ?? card.dataset.weaponClass ?? 'primary';
      const selected = Boolean(option) && this.loadout[classId] === option.id;
      card.dataset.selected = String(selected);
      card.dataset.ready = String(Boolean(option?.ready));
      card.disabled = !option?.ready;
      card.hidden = classId !== this.activeClass;
      const state = card.querySelector('[data-card-state]');
      if (state) state.textContent = option?.ready ? (selected ? 'equipped' : 'ready') : 'loading';
    }
    for (const tab of el.classTabs ?? []) {
      const classId = tab.dataset.weaponClass;
      tab.dataset.on = String(classId === this.activeClass);
      const pick = this.weaponOptions.find((weapon) => weapon.id === this.loadout[classId]);
      const label = tab.querySelector('[data-tab-pick]');
      if (label) label.textContent = pick ? (pick.name ?? pick.id) : '';
    }
    const active = this.classes.find((cls) => cls.id === this.activeClass);
    const selected = this.weaponOptions.find((weapon) => weapon.id === this.loadout[this.activeClass]);
    if (el.classSelection) {
      el.classSelection.textContent = selected
        ? `${selected.name ?? selected.id} selected`
        : `Select a ${(active?.label ?? 'weapon').toLowerCase()}`;
    }
    if (el.classSub) el.classSub.textContent = active?.hint ?? '';
    const primary = this.weaponOptions.find((weapon) => weapon.id === this.loadout.primary);
    if (el.classConfirm) el.classConfirm.disabled = !primary?.ready;
  }
}
