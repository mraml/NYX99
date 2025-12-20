import { BaseState } from './BaseState.js';
import worldGraph from '../../data/worldGraph.js';
import { isAgentWorkShift } from '../agentUtilities.js'; 
import eventBus from '../eventBus.js';

/**
 * WorkingState.js
 * (MODIFIED: Removed all hardcoded activity descriptions and strings.)
 * [REF] Stateless Flyweight Version
 */
export class WorkingState extends BaseState {
    
    // [REF] Added agent param
    enter(agent) {
        super.enter(agent);
        this._updateActivityFromState(agent); 
        
        const locName = worldGraph.nodes[agent.workLocationId]?.name || 'work';
        
        // --- EMPLOYMENT STATUS LOGIC ---
        const hasJobObject = agent.job && typeof agent.job === 'object';
        const jobTitle = hasJobObject ? agent.job.title : 'No Job Object';
        
        // Use isSeekingEmployment flag: Only true if job object is missing OR title is explicitly 'Unemployed'.
        agent.stateContext.isSeekingEmployment = !hasJobObject || jobTitle === 'Unemployed';
        agent.stateContext.jobHuntDuration = 0;
        agent.stateContext.MAX_JOB_HUNT_TICKS = 60; 
        agent.stateContext.consecutiveStressTicks = 0;

        if (agent.stateContext.isSeekingEmployment) {
            if (agent.lod === 1) {
                this.log(`[${agent.name}] Seeking Employment triggered. (Job Status: ${jobTitle})`);
            }
        } else if (agent.lod === 1) {
            this.log(`[${agent.name}] Clocking in at ${locName} as ${jobTitle}.`);
        }
    }

    // [REF] Added agent param
    tick(agent, hour, localEnv, worldState) {
        super.tick(agent, hour, localEnv, worldState);

        let isDirty = (worldState.currentTick % 10 === 0);

        // --- 0. UNEMPLOYED / JOB HUNTING EXIT ---
        if (agent.stateContext.isSeekingEmployment) {
            agent.stateContext.jobHuntDuration++;
            
            agent.energy = Math.max(0, (agent.energy ?? 0) - 0.5);
            agent.stress = Math.min(100, (agent.stress ?? 0) + 0.2);

            // Job hunting ends after duration or if agent is exhausted
            if (agent.stateContext.jobHuntDuration >= agent.stateContext.MAX_JOB_HUNT_TICKS || agent.energy < 20) {
                this.log(`[${agent.name}] Finished employment seeking session.`);
                this._leaveWork(agent);
                return { isDirty: true, walOp: { op: 'AGENT_STATE_UPDATE', data: { state: 'fsm_idle' } } };
            }
            
            if (Math.random() < 0.01) {
                // Hardcoded memory message removed, replaced with a generic notification of a successful event
                eventBus.emitNow('db:writeMemory', 'low', agent.id, worldState.currentTick, `Found a potential employment opportunity.`);
                agent.mood = Math.min(100, (agent.mood ?? 0) + 5);
            }
            
            return { isDirty, walOp: null };
        }

        // --- 1. EMPLOYED LOGIC: SHIFT END CHECK ---
        const isWorkShift = isAgentWorkShift(agent, hour);

        if (!isWorkShift) {
             const isFlowing = (agent.energy ?? 0) > 60 && (agent.mood ?? 0) > 60;
             const isDesperate = (agent.money ?? 0) < 100;
             const isWorkaholic = (agent.persona?.conscientiousness ?? 0.5) > 0.8;
             
             // If outside shift, transition immediately unless one of the conditions forces working late.
             if (!isFlowing && !isDesperate && !(isWorkaholic && Math.random() < 0.1)) {
                 this.log(`[${agent.name}] Shift is over. Heading out.`);
                 this._leaveWork(agent);
                 return { isDirty: true, walOp: { op: 'AGENT_STATE_UPDATE', data: { state: 'fsm_idle' } } };
             }
        }
        
        // --- 2. ENVIRONMENT & COWORKERS (Runs only if employed) ---
        if ((localEnv.condition ?? 100) < 50 || (localEnv.noise ?? 0) > 0.7) {
            agent.stress = Math.min(100, (agent.stress ?? 0) + 0.05);
        }

        const coworkerCount = agent.perceivedAgents?.length || 0;
        if (coworkerCount > 0) {
            agent.social = Math.min(100, (agent.social ?? 0) + 0.1);
            const extroversion = agent.persona?.extroversion ?? 0.5;
            if (extroversion > 0.6) {
                agent.stress = Math.max(0, (agent.stress ?? 0) - 0.05); 
            } else if (extroversion < 0.3 && coworkerCount > 3) {
                agent.stress = Math.min(100, (agent.stress ?? 0) + 0.05); 
            }
        }

        // --- 3. BURNOUT CHECK ---
        if ((agent.stress ?? 0) > 90) {
            agent.stateContext.consecutiveStressTicks++;
            if (agent.stateContext.consecutiveStressTicks > 10) {
                if (Math.random() < 0.05) { 
                    this.log(`[${agent.name}] BURNOUT: Leaving work early due to high stress.`);
                    agent.stress -= 10; 
                    // Hardcoded memory message removed
                    eventBus.emitNow('db:writeMemory', 'high', agent.id, worldState.currentTick, `Left work due to stress/burnout.`);
                    
                    this._leaveWork(agent);
                    return { isDirty: true, walOp: { op: 'AGENT_STATE_UPDATE', data: { state: 'fsm_idle' } } };
                }
            }
        } else {
            agent.stateContext.consecutiveStressTicks = 0;
        }

        // --- 4. FLOW STATE & PERFORMANCE ---
        const isFlowing = (agent.energy ?? 0) > 60 && (agent.mood ?? 0) > 50;
        let stressChange = 0.05; 

        if (isFlowing) {
            stressChange = -0.05; 
            if (Math.random() < 0.01) {
                const bonus = 10;
                agent.money += bonus;
                // Hardcoded log message removed
                if (agent.lod === 1) this.log(`[${agent.name}] Earned a work bonus ($${bonus}).`);
            }
        } 

        // --- 5. MICRO-DISTRACTIONS (Applies only if employed) ---
        if (!agent.stateContext.isSeekingEmployment && Math.random() < 0.01 && !isFlowing) {
            const PRIORITY_DISTRACTION = 10; 
            const DISTRACTION_DURATION = 2; 

            if (Math.random() < 0.5) {
                // Ensure intentions exist
                if (!agent.intentionStack) agent.intentionStack = [];
                
                agent.intentionStack.push({
                    goal: 'fsm_recreation',
                    priority: PRIORITY_DISTRACTION,
                    target: agent.locationId,
                    // Hardcoded reason removed, relies on destination state (fsm_recreation) being descriptive
                    context: { duration: DISTRACTION_DURATION }
                });
                
                // [REF] Return transition
                return { isDirty: true, walOp: { op: 'AGENT_STATE_UPDATE', data: { state: 'fsm_recreation' } }, nextState: 'fsm_recreation' };
            }
        }

        // --- 6. ENVIRONMENTAL EVENTS ---
        const powerOutage = (worldState.world_events ?? []).find(e => e?.type === 'POWER_OUTAGE');
        if (powerOutage) {
            const locationNode = worldGraph.nodes[agent.locationId];
            if (locationNode && (locationNode.type === 'office' || locationNode.type === 'commercial')) {
                this.log(`[${agent.name}] Leaving work due to power outage.`);
                this._leaveWork(agent);
                return { isDirty: true, walOp: { op: 'AGENT_STATE_UPDATE', data: { state: 'fsm_idle' } } };
            }
        }

        if ((agent.persona?.conscientiousness ?? 0.5) > 0.7) {
            stressChange -= 0.02; 
        }

        agent.stress = Math.min(100, Math.max(0, (agent.stress ?? 0) + stressChange));
        
        return { isDirty, walOp: null };
    }

    // [REF] Added agent param
    _leaveWork(agent) {
         // Use optional chaining for safety
         const currentIntention = agent.intentionStack?.[agent.intentionStack.length - 1];
         // Updated intention check for new flag
         if (currentIntention && (currentIntention.goal.startsWith('fsm_working_') || currentIntention.goal === 'fsm_seeking_employment')) {
            agent.intentionStack.pop();
         }
    }
}