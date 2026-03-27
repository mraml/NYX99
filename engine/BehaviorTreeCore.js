/**
 * BehaviorTreeCore.js
 * A stateless, reactive Behavior Tree engine designed for Node.js Worker environments.
 * * CONCEPT:
 * Nodes (Selector, Sequence) are static definitions.
 * State is read/written entirely from the 'agent' and 'context' objects passed into execute().
 */

export const Status = {
    SUCCESS: 'SUCCESS',
    FAILURE: 'FAILURE',
    RUNNING: 'RUNNING'
};

// === COMPOSITE NODES ===

/**
 * Selector (Fallback)
 * Runs children in order. 
 * - If a child succeeds, the Selector succeeds (OR logic).
 * - If a child fails, it tries the next one.
 * - If all fail, the Selector fails.
 */
export class Selector {
    constructor(children = []) {
        this.children = children;
    }

    execute(agent, context) {
        for (const child of this.children) {
            const status = child.execute(agent, context);
            
            // Check for immediate transition interrupt
            if (context.transition) {
                return Status.SUCCESS; // Interrupt execution, propagate up
            }

            if (status !== Status.FAILURE) {
                return status; // SUCCESS or RUNNING
            }
        }
        return Status.FAILURE;
    }
}

/**
 * Sequence
 * Runs children in order.
 * - If a child succeeds, it runs the next one (AND logic).
 * - If a child fails, the Sequence fails immediately.
 * - If all succeed, the Sequence succeeds.
 */
export class Sequence {
    constructor(children = []) {
        this.children = children;
    }

    execute(agent, context) {
        for (const child of this.children) {
            const status = child.execute(agent, context);

            // CRITICAL FIX: Early exit on transition
            // If an action triggered a state change, stop the sequence immediately.
            // We return SUCCESS so parents don't treat it as a failure, 
            // but the FSM tick will see context.transition and switch states.
            if (context.transition) {
                return Status.SUCCESS;
            }

            if (status !== Status.SUCCESS) {
                return status; // FAILURE or RUNNING
            }
        }
        return Status.SUCCESS;
    }
}

// === DECORATOR NODES ===

/**
 * Inverter
 * Flips Success to Failure and vice-versa. Running stays Running.
 */
export class Inverter {
    constructor(child) {
        this.child = child;
    }

    execute(agent, context) {
        const status = this.child.execute(agent, context);
        if (status === Status.SUCCESS) return Status.FAILURE;
        if (status === Status.FAILURE) return Status.SUCCESS;
        return status;
    }
}

/**
 * Chance
 * Randomly executes the child or fails.
 */
export class Chance {
    constructor(probability, child) {
        this.probability = probability;
        this.child = child;
    }

    execute(agent, context) {
        if (Math.random() < this.probability) {
            return this.child.execute(agent, context);
        }
        return Status.FAILURE;
    }
}

// === LEAF NODES ===

/**
 * Condition
 * Checks a boolean function. Returns SUCCESS or FAILURE.
 * Never returns RUNNING.
 */
export class Condition {
    constructor(fn) {
        this.fn = fn;
    }

    execute(agent, context) {
        return this.fn(agent, context) ? Status.SUCCESS : Status.FAILURE;
    }
}

/**
 * Action
 * Executes a function that performs work.
 * The function should return:
 * - A Status string (SUCCESS, FAILURE, RUNNING)
 * - OR a plain object (for FSM transitions/WAL Ops) which implies SUCCESS.
 */
export class Action {
    constructor(fn) {
        this.fn = fn;
    }

    execute(agent, context) {
        const result = this.fn(agent, context);
        
        // Handle explicit Status return
        if (typeof result === 'string') {
            return result;
        }

        // Handle Object Return (Transitions, WAL Ops, Dirty Flags)
        // If an action returns an object, we must merge it into the context's
        // transition/operation buffer so the FSM can see it.
        if (result && typeof result === 'object') {
            // Ensure context has a container for results if not present
            if (!context.walOp) context.walOp = null;
            if (context.isDirty === undefined) context.isDirty = false;

            // 1. Handle State Transitions
            if (result.nextState) {
                // If there's already a transition, we might be overwriting it (last writer wins in sequence)
                // But typically only one action triggers a transition per tick.
                context.transition = result;
            }

            // 2. Handle WAL Operations (Append/Merge)
            // Note: FSM usually expects a single walOp or array.
            // If context already has a walOp, we might need to array-ify it.
            if (result.walOp) {
                if (context.walOp) {
                    if (Array.isArray(context.walOp)) {
                        context.walOp.push(result.walOp);
                    } else {
                        context.walOp = [context.walOp, result.walOp];
                    }
                } else {
                    context.walOp = result.walOp;
                }
            }

            // 3. Handle Dirty Flag
            if (result.isDirty) {
                context.isDirty = true;
            }

            return Status.SUCCESS;
        }

        // Default to SUCCESS if nothing returned (void function)
        return Status.SUCCESS;
    }
}