// Playback/run state as a pure reducer. Phases: idle -> loading -> ready | failed. The trace is replaced
// wholesale on every run; stepping only moves `index` inside it.
import { reconstruct } from "./reconstruct";

export const SPEEDS = Object.freeze([0.5, 1, 2, 4, 8]);
export const DEFAULT_SPEED_INDEX = 1;

export const initialState = Object.freeze({
  phase: "idle",
  trace: null,
  views: [],
  index: 0,
  playing: false,
  speedIndex: DEFAULT_SPEED_INDEX,
  error: null,
});

const clampIndex = (index, length) => Math.max(0, Math.min(index, Math.max(0, length - 1)));

export function playerReducer(state, action) {
  switch (action.type) {
    case "run/start":
      return { ...initialState, phase: "loading", speedIndex: state.speedIndex };
    case "run/success":
      return {
        ...state,
        phase: "ready",
        trace: action.trace,
        views: reconstruct(action.trace),
        index: 0,
        playing: false,
        error: null,
      };
    case "run/failure":
      return { ...initialState, phase: "failed", speedIndex: state.speedIndex, error: action.message };
    case "step/next": {
      const index = clampIndex(state.index + 1, state.views.length);
      return { ...state, index, playing: state.playing && index < state.views.length - 1 };
    }
    case "step/prev":
      return { ...state, index: clampIndex(state.index - 1, state.views.length), playing: false };
    case "step/seek":
      return { ...state, index: clampIndex(action.index, state.views.length), playing: false };
    case "step/reset":
      return { ...state, index: 0, playing: false };
    case "play/toggle": {
      if (state.phase !== "ready" || state.views.length === 0) return state;
      if (state.playing) return { ...state, playing: false };
      const atEnd = state.index >= state.views.length - 1;
      return { ...state, index: atEnd ? 0 : state.index, playing: true };
    }
    case "speed/set":
      return { ...state, speedIndex: Math.max(0, Math.min(action.index, SPEEDS.length - 1)) };
    default:
      return state;
  }
}

/** Milliseconds between steps while playing. */
export const stepDelayMs = (speedIndex) => Math.round(800 / SPEEDS[speedIndex]);
