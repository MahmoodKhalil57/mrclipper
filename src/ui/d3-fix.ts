// d3-zoom (used by React Flow for pan/zoom/fitView) needs d3-transition's patch of selection.prototype.
// Bun's bundler drops that patch as a "side-effect-free" import on Windows (its sideEffects globs don't
// match backslash paths), which silently disables zooming and fitView. Apply the patch here instead.
import { selection } from "d3-selection";
// @ts-expect-error untyped internal module, imported by path to bypass the package's exports map
import selectionInterrupt from "../../node_modules/d3-transition/src/selection/interrupt.js";
// @ts-expect-error untyped internal module, imported by path to bypass the package's exports map
import selectionTransition from "../../node_modules/d3-transition/src/selection/transition.js";

const proto = selection.prototype as any;
proto.interrupt ??= selectionInterrupt;
proto.transition ??= selectionTransition;
