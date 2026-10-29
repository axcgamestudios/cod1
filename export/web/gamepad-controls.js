/**
 * GamepadControls: Xbox and PlayStation controller support.
 *
 * Both consoles (and most third-party pads) expose the browser's "standard
 * gamepad" mapping, so one button table serves them all:
 *
 *   0 A / Cross        4 LB / L1        8 View / Share / Back
 *   1 B / Circle       5 RB / R1        9 Menu / Options / Start
 *   2 X / Square       6 LT / L2      10 L3 (left stick click)
 *   3 Y / Triangle     7 RT / R2      11 R3 (right stick click)
 *   12..15 D-pad up / down / left / right
 *
 * The layout follows console Call of Duty: left stick moves, right stick
 * looks, RT fires, LT aims, L3 sprints, X reloads, A jumps, B crouches,
 * Y swaps weapons, R3 melees, RB throws the frag (hold to cook), LB the
 * tactical. View holds the scoreboard; Menu pauses.
 *
 * The pad also navigates the frontend shell: the stick and D-pad move
 * button focus, A activates, B backs out. `active` is only true once the
 * pad has reported input, so a pad sitting in a drawer never steals the
 * mouse's pointer lock.
 */

import * as THREE from 'three';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// Radial dead zones. Sticks report noise at rest and drift around centre;
// a radial zone (rather than per-axis) keeps diagonal movement honest.
const MOVE_DEAD_ZONE = 0.18;
const LOOK_DEAD_ZONE = 0.12;

// Full-stick look rate, radians per second. Console COD turns roughly a
// revolution in two seconds at default sensitivity; the settings slider
// multiplies this.
const BASE_LOOK_RATE = 2.75;

// Aim assist window. Inside this angle of the crosshair a target slows the
// stick and receives a gentle pull, the way console shooters compensate for
// thumbs. The toggle lives in settings; the pull only ever nudges.
const ASSIST_SLOW_ANGLE = 0.12; // ~7 degrees
const ASSIST_SNAP_ANGLE = 0.045; // ~2.6 degrees
const ASSIST_PULL_RATE = 1.35; // rad/s toward the target at full closeness

// Standard-mapping button indices, named for readability.
const BUTTON = {
  A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7,
  VIEW: 8, MENU: 9, L3: 10, R3: 11,
  UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15,
};

export class GamepadControls {
  constructor({
    onLook = () => {}, onAction = () => {}, onMenuButton = () => {},
    onMenuMove = () => {}, onConnect = () => {},
    getAimTargets = () => [], getSettings = () => ({}),
  } = {}) {
    this.onLook = onLook;
    this.onAction = onAction;
    // Menu / Start: pause during play, activate in menus.
    this.onMenuButton = onMenuButton;
    // Directional push while a shell screen is up (stick or D-pad).
    this.onMenuMove = onMenuMove;
    this.onConnect = onConnect;
    // World-space aim-assist targets (enemy chest positions, updated by host).
    this.getAimTargets = getAimTargets;
    this.getSettings = getSettings;

    this.connected = false;
    this.active = false; // true once the pad has produced input
    this.id = '';
    this.index = -1;
    this.type = 'xbox'; // 'xbox' | 'playstation' | 'generic'
    this.paused = false;

    this.sticks = { moveX: 0, moveY: 0, lookX: 0, lookY: 0 };
    this.held = new Set();
    this.prev = new Set();
    this.triggers = { fire: false, aim: false };
    this.menuRepeat = 0;
    this.assistTarget = null;

    window.addEventListener('gamepadconnected', (event) => this.connect(event.gamepad));
    window.addEventListener('gamepaddisconnected', (event) => this.disconnect(event.gamepad));
    // Pads already paired when the page loaded only fire `gamepadconnected`
    // in some browsers; Chrome does, Safari does not.
    for (const pad of navigator.getGamepads?.() ?? []) if (pad) this.connect(pad);
  }

  connect(pad) {
    this.connected = true;
    this.index = pad.index;
    this.id = pad.id;
    const id = pad.id.toLowerCase();
    this.type = id.includes('054c') || id.includes('sony') || id.includes('dualshock') || id.includes('dualsense')
      || id.includes('playstation') ? 'playstation'
      : id.includes('xbox') || id.includes('045e') || id.includes('xinput') ? 'xbox' : 'generic';
    this.onConnect(this);
  }

  disconnect(pad) {
    if (pad && this.index !== pad.index) return;
    this.connected = false;
    this.active = false;
    this.index = -1;
    this.held.clear();
    this.prev.clear();
    this.triggers.fire = this.triggers.aim = false;
    this.sticks.moveX = this.sticks.moveY = this.sticks.lookX = this.sticks.lookY = 0;
  }

  /** True while a pad is both plugged in and being used. */
  get playing() { return this.connected && this.active; }

  pad() {
    const pads = navigator.getGamepads?.() ?? [];
    if (this.index >= 0 && pads[this.index]?.connected) return pads[this.index];
    // Reconnects can move indexes around; take the first live pad.
    for (const pad of pads) {
      if (pad?.connected) { this.index = pad.index; this.connect(pad); return pad; }
    }
    return null;
  }

  /**
   * Read the pad once per animation frame. Emits look deltas, edge-triggered
   * actions, and menu navigation; returns the continuous movement state that
   * `tick()` merges with keyboard and touch.
   */
  poll(dt, { menu = false, playing = false } = {}) {
    const pad = this.pad();
    if (!pad) {
      if (this.held.size || this.triggers.fire || this.triggers.aim) {
        this.held.clear();
        this.triggers.fire = this.triggers.aim = false;
        this.sticks.moveX = this.sticks.moveY = this.sticks.lookX = this.sticks.lookY = 0;
      }
      return null;
    }

    const pressed = (index) => pad.buttons[index]?.pressed;
    const value = (index) => pad.buttons[index]?.value ?? (pressed(index) ? 1 : 0);
    this.held.clear();
    for (let i = 0; i < pad.buttons.length; i++) {
      if (value(i) > 0.35 || pressed(i)) this.held.add(i);
    }

    // --- sticks ---
    const move = radialDeadZone(pad.axes[0] ?? 0, pad.axes[1] ?? 0, MOVE_DEAD_ZONE);
    this.sticks.moveX = move.x;
    this.sticks.moveY = move.y;
    // Left stick deflection counts as input: this is what flips `active` so a
    // pad-only player never needs to touch the mouse.
    if (!this.active && (move.magnitude > 0 || this.held.size)) {
      this.active = true;
      this.onConnect(this);
    }

    const look = radialDeadZone(pad.axes[2] ?? 0, pad.axes[3] ?? 0, LOOK_DEAD_ZONE);
    this.sticks.lookX = look.x;
    this.sticks.lookY = look.y;

    // --- triggers (analog: full pull required, half pulls are often noise) ---
    this.triggers.fire = value(BUTTON.RT) > 0.45;
    this.triggers.aim = value(BUTTON.LT) > 0.45;

    // --- edge-triggered gameplay actions ---
    if (playing) {
      this.fireEdge(BUTTON.X, () => this.onAction('reload'));
      this.fireEdge(BUTTON.Y, () => this.onAction('switch'));
      this.fireEdge(BUTTON.R3, () => this.onAction('melee'));
      this.fireEdge(BUTTON.UP, () => this.onAction('camo'));
      // Frag cooks while RB is down and throws on release, matching the
      // keyboard's hold-to-cook.
      this.fireEdge(BUTTON.RB, () => this.onAction('frag', 'start'));
      if (!this.held.has(BUTTON.RB) && this.prev.has(BUTTON.RB)) this.onAction('frag', 'release');
      this.fireEdge(BUTTON.LB, () => this.onAction('smoke'));
      this.fireEdge(BUTTON.LEFT, () => this.onAction('switch', -1));
      this.fireEdge(BUTTON.RIGHT, () => this.onAction('switch', 1));
      // B toggles crouch like the game's console layout (hold-free).
      this.fireEdge(BUTTON.B, () => this.onAction('crouch'));
      if (this.consume(BUTTON.MENU)) this.onMenuButton();
    } else if (menu) {
      // --- shell navigation ---
      if (this.consume(BUTTON.MENU)) this.onMenuButton();
      if (this.consume(BUTTON.A)) this.onAction('menu-confirm');
      if (this.consume(BUTTON.B)) this.onAction('menu-back');
      this.menuRepeat -= dt;
      const dx = (this.held.has(BUTTON.RIGHT) ? 1 : 0) - (this.held.has(BUTTON.LEFT) ? 1 : 0);
      const dy = (this.held.has(BUTTON.DOWN) ? 1 : 0) - (this.held.has(BUTTON.UP) ? 1 : 0);
      const navX = dx || (Math.abs(move.x) > 0.55 ? Math.sign(move.x) : 0);
      const navY = dy || (Math.abs(move.y) > 0.55 ? Math.sign(move.y) : 0);
      if ((navX || navY) && this.menuRepeat <= 0) {
        this.menuRepeat = 0.22;
        this.onMenuMove(navX, navY);
        this.active = true;
      }
      if (!navX && !navY) this.menuRepeat = 0;
    }

    // --- look ---
    if (playing && (look.magnitude > 0 || this.assistTarget)) {
      this.applyLook(pad, dt, look);
    }

    this.prev = new Set(this.held);
    return this.read();
  }

  applyLook(pad, dt, look) {
    const settings = this.getSettings();
    const sensitivity = clamp(Number(settings.gamepadSensitivity) || 1, 0.2, 3);
    const ads = Number(settings.adsSensitivity) || 0.8;
    const aiming = Boolean(settings.aiming);
    let rate = BASE_LOOK_RATE * sensitivity * (aiming ? ads : 1);

    let x = look.x * rate * dt;
    let y = look.y * rate * dt;

    // Aim assist: slow down near a target, pull gently when almost on it.
    this.assistTarget = null;
    if (settings.aimAssist !== false) {
      const target = this.pickAssistTarget(settings.camera);
      if (target) {
        const distance = Math.hypot(target.yawError, target.pitchError);
        if (distance < ASSIST_SLOW_ANGLE) {
          // Slowdown, eased so the edge is not a wall.
          const closeness = 1 - distance / ASSIST_SLOW_ANGLE;
          rate *= 1 - 0.4 * closeness;
          x = look.x * rate * dt;
          y = look.y * rate * dt;
          if (distance < ASSIST_SNAP_ANGLE && (look.magnitude > 0.12 || aiming)) {
            // Rotation: chase the target centre, capped, stronger when closer.
            const pull = ASSIST_PULL_RATE * dt * closeness;
            const error = Math.hypot(target.yawError, target.pitchError) || 1;
            x -= (target.yawError / error) * Math.min(pull, Math.abs(target.yawError));
            y -= (target.pitchError / error) * Math.min(pull, Math.abs(target.pitchError));
            this.assistTarget = target;
          }
        }
      }
    }

    const invertY = Boolean(settings.invertY);
    this.onLook(x, invertY ? -y : y);
  }

  /** The live enemy nearest the crosshair, with yaw/pitch deltas to its chest. */
  pickAssistTarget(camera) {
    if (!camera) return null;
    const targets = this.getAimTargets();
    if (!targets.length) return null;
    // Reuse scratch objects; poll() runs every frame.
    this._dir ??= new THREE.Vector3();
    this._proj ??= new THREE.Vector3();
    this._euler ??= new THREE.Euler(0, 0, 0, 'YXZ');
    camera.getWorldDirection(this._dir);
    this._euler.setFromQuaternion(camera.quaternion);
    let best = null;
    let bestScore = ASSIST_SLOW_ANGLE;
    for (const target of targets) {
      this._proj.copy(target).sub(camera.position);
      const distance = this._proj.length();
      if (distance < 40) continue; // point-blank: no assist needed
      this._proj.divideScalar(distance);
      const dot = this._proj.dot(this._dir);
      if (dot <= 0.2) continue; // far off-screen or behind
      // Angle between the crosshair and the target.
      const angle = Math.acos(clamp(dot, -1, 1));
      if (angle >= bestScore) continue;
      // Yaw/pitch needed to centre the target (camera looks down -Z, YXZ order).
      const horizontal = Math.hypot(this._proj.x, this._proj.z);
      const targetYaw = Math.atan2(-this._proj.x, -this._proj.z);
      const targetPitch = Math.atan2(this._proj.y, horizontal);
      best = {
        distance,
        yawError: THREE.MathUtils.euclideanModulo(targetYaw - this._euler.y + Math.PI, Math.PI * 2) - Math.PI,
        pitchError: targetPitch - this._euler.x,
      };
      bestScore = angle;
    }
    return best;
  }

  /** Continuous state for tick(): merged with keyboard and touch there. */
  read() {
    return {
      forward: -this.sticks.moveY,
      strafe: this.sticks.moveX,
      sprint: this.held.has(BUTTON.L3) || Math.hypot(this.sticks.moveX, this.sticks.moveY) > 0.985,
      // B is a console-style toggle: press to crouch, press again to stand.
      crouch: Boolean(this._crouch),
      jump: this.held.has(BUTTON.A),
      aim: this.triggers.aim,
      fire: this.triggers.fire,
      // VIEW holds the scoreboard; the host reads this every frame.
      scores: this.held.has(BUTTON.VIEW),
    };
  }

  // B is an edge-triggered crouch toggle in play (console style), so the
  // toggle lives here where the edge is detected.
  get crouchToggle() { return this._crouch || false; }
  set crouchToggle(value) { this._crouch = Boolean(value); }

  fireEdge(index, action) {
    if (this.held.has(index) && !this.prev.has(index)) action();
  }

  consume(index) {
    return this.held.has(index) && !this.prev.has(index);
  }

  /** Crouch is toggled by the host on the 'crouch' action. */
  toggleCrouch() { this._crouch = !this._crouch; }
  clearCrouch() { this._crouch = false; }

  rumble({ strong = 0, weak = 0, duration = 0 } = {}) {
    if (!this.connected) return false;
    const settings = this.getSettings();
    if (settings.vibration === false) return false;
    const pad = this.pad();
    const actuator = pad?.vibrationActuator;
    if (!actuator?.playEffect) return false;
    actuator.playEffect('dual-rumble', {
      startDelay: 0,
      duration: Math.max(16, Math.round(duration * 1000)),
      strongMagnitude: clamp(strong, 0, 1),
      weakMagnitude: clamp(weak, 0, 1),
    }).catch(() => {});
    return true;
  }

  getState() {
    return {
      connected: this.connected,
      active: this.active,
      type: this.type,
      id: this.id,
      crouch: this._crouch || false,
      assist: Boolean(this.assistTarget),
    };
  }
}

function radialDeadZone(x, y, zone) {
  const magnitude = Math.hypot(x, y);
  if (magnitude <= zone) return { x: 0, y: 0, magnitude: 0 };
  // Rescale so the usable range starts at the zone edge, not at zero.
  const scale = (magnitude - zone) / (1 - zone) / magnitude;
  return { x: x * scale, y: y * scale, magnitude: (magnitude - zone) / (1 - zone) };
}
