import { useSyncExternalStore } from "react";
import type {
  RunConsoleController,
  RunConsoleState
} from "@lecoding/run-controller";

/**
 * Subscribes a component to the controller's immutable snapshot.
 *
 * Deliberately a few lines: every Run-state transition lives in the shared
 * controller, so React is only a projection. Replacing React later means
 * replacing this adapter, not the console's behaviour.
 */
export function useControllerState(
  controller: RunConsoleController
): RunConsoleState {
  return useSyncExternalStore(
    (onStoreChange) => controller.subscribe(() => onStoreChange()),
    () => controller.getState()
  );
}
