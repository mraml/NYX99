import { BaseState } from './BaseState.js';
import { Selector, Sequence, Condition, Action, Status } from '../BehaviorTreeCore.js';
import { GAME_BALANCE } from '../../data/balance.js';
import worldGraph from '../../data/worldGraph.js';

const LC = GAME_BALANCE.LIFECYCLE;

const Conditions = {
    IsHomeless: (agent) => !agent.homeLocationId,
    IsTired: (agent) => (agent.energy || 100) < 40,
    IsHungry: (agent) => (agent.hunger || 0) > 60,
    IsBored: (agent) => (agent.boredom ?? 0) > 50,
    IsLonely: (agent) => (agent.social ?? 0) > 60,
};

const Actions = {
    CollectPension: (agent) => {
        agent.money = (agent.money || 0) + (LC.PENSION_DAILY_INCOME / 96);
        return Status.SUCCESS;
    },

    GoSleep: (agent) => {
        return { isDirty: true, nextState: 'fsm_sleeping' };
    },

    GoEat: (agent) => {
        return { isDirty: true, nextState: 'fsm_eating' };
    },

    GoSocialize: (agent) => {
        return { isDirty: true, nextState: 'fsm_socializing' };
    },

    GoRecreation: (agent) => {
        return { isDirty: true, nextState: 'fsm_recreation' };
    },

    SeekHousing: (agent) => {
        return { isDirty: true, nextState: 'fsm_acquire_housing' };
    },

    DoRetiredActivity: (agent) => {
        agent.stress = Math.max(0, (agent.stress || 0) - 0.3);
        agent.boredom = Math.max(0, (agent.boredom ?? 0) - 1.0);

        if (!agent.currentActivityName || agent.currentActivityName === 'idling') {
            const activities = [
                'reading newspaper', 'watching TV', 'sitting in park',
                'feeding pigeons', 'doing crossword', 'napping',
                'listening to radio', 'writing letters',
            ];
            agent.currentActivityName = activities[Math.floor(Math.random() * activities.length)];
        }

        return Status.SUCCESS;
    },
};

const RetiredTree = new Selector([
    new Sequence([
        new Condition(Conditions.IsHomeless),
        new Action(Actions.SeekHousing),
    ]),
    new Sequence([
        new Condition(Conditions.IsHungry),
        new Action(Actions.GoEat),
    ]),
    new Sequence([
        new Condition(Conditions.IsTired),
        new Action(Actions.GoSleep),
    ]),
    new Sequence([
        new Condition(Conditions.IsLonely),
        new Action(Actions.GoSocialize),
    ]),
    new Sequence([
        new Condition(Conditions.IsBored),
        new Action(Actions.GoRecreation),
    ]),
    new Action(Actions.CollectPension),
    new Action(Actions.DoRetiredActivity),
]);

export class RetiredState extends BaseState {
    constructor() {
        super();
        this.name = 'fsm_retired';
    }

    enter(agent) {
        super.enter(agent);
        agent.currentActivityName = 'enjoying retirement';
        this._updateActivityFromState(agent);
    }

    tick(agent, hour, localEnv, worldState) {
        super.tick(agent, hour, localEnv, worldState);

        const context = { hour, localEnv, worldState, transition: null };
        RetiredTree.execute(agent, context);

        if (context.transition) return context.transition;

        return { isDirty: (worldState.currentTick % 10 === 0), walOp: null };
    }
}
