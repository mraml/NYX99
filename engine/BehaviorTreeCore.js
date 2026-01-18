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
 * - OR a plain object (for FSM transitions) which implies SUCCESS.
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

        // Handle Transition Object (e.g., { nextState: 'fsm_idle' })
        // If an action returns an object, we attach it to the context for the FSM to see, and return SUCCESS
        if (result && typeof result === 'object') {
            if (result.nextState) {
                context.transition = result; // Pass bubble-up data
            }
            return Status.SUCCESS;
        }

        // Default to SUCCESS if nothing returned (void function)
        return Status.SUCCESS;
    }
}