# **Project: NYC 1999 Simulation**

**Document Version:** 1.0 **Date:** November 17, 2025

## **1\. Executive Summary**

The goal of this project is to create a high-performance, emergent agent-based simulation of New York City in 1999\.

The core architecture is now in place. The simulation is data-driven (YAML configs), multithreaded (worker pool), and uses a robust State Pattern for agent AI. All major performance bottlenecks related to startup hangs and runtime freezes have been resolved.

The simulation's primary focus has now shifted from **performance** to **behavioral tuning**. The engine is stable, but agents exhibit a uniform "death spiral":

* Core needs (Energy, Hunger, Social) bottom out at 0%.  
* Emotions max out (Stress 100%, Mood \-100%).  
* The AI's utility scoring (via `actionScorer.js`) incorrectly prioritizes long-term aspirations (e.g., "BECOME RICH") over critical, short-term survival needs.

This indicates the next phase of work is to re-architect the AI's decision-making logic to create a balanced, believable "Maslow's Hierarchy of Needs."

## **2\. Core Architecture: Current Implementation**

The following systems are implemented, stable, and performant.

* **Multithreaded Architecture (v8.0):** The simulation runs on a worker pool, with agents partitioned by location. The main thread handles state synchronization, I/O, and world updates, ensuring a non-blocking UI. (Ref: `engine/matrix.js`, `engine/worldPartitioner.js`)  
* **Data-Driven Design (v2.0):** All core simulation data (activities, items, locations, agent generation) is loaded from YAML configuration files. (Ref: `data/dataLoader.js`)  
* **State Pattern FSM (v4.5):** The monolithic FSM has been refactored into a clean State Pattern, where each state (`SleepingState.js`, `WorkingState.js`, etc.) manages its own `enter()`, `tick()`, and `exit()` logic.  
* **O(n) Startup Performance (v8.1):** The O(n²) agent relationship seeding loop (the cause of slow loads) has been fixed. The `cacheManager` now passes the full agent list to a new O(1) utility, resulting in an O(n) total load time. (Ref: `cacheManager.js`, `agentUtilities.js`)  
* **Instant Load (v8.3):** The O(n³) affordance cache pre-calculation (the cause of the multi-minute startup hang) has been **removed**. Affordance lookups (e.g., "find nearest store") are now lazy-loaded and cached on-demand in the agent scoring files. (Ref: `matrix.js`, `scorerNeeds.js`, `scorerSocioEmotional.js`)  
* **O(n) Runtime Performance (v8.2):** All O(n²) runtime freezes (which occurred when many agents tried to socialize or perceive their environment) have been **fixed**. The `matrix.js` main loop now pre-calculates all location-based social context in a single O(n) pass, which all agents can look up in O(1). (Ref: `matrix.js`, `scorerContext.js`, `SocializingState.js`)  
* **LOD-Aware Perception (v8.9):** The "Agents Nearby: 0" bug has been fixed. Agent perception logic now runs *before* the LOD2 "bailout" check, ensuring all agents (in focus or not) correctly update their environmental perceptions. (Ref: `fsm.js`, `actionScorer.js`)  
* **Passive Need Increase (v8.5):** The `BaseState.js` `tick()` method now correctly increases all agent needs (Hunger, Energy, Social, Boredom) over time, which is inherited by all other states.

## **3\. Current Simulation State & Known Issues**

**Current Behavior:** The simulation is stable but behaviorally broken. After several hours, all agents enter a "death spiral" where they work 100% of the time, regardless of the time of day or their physical state.

**Observed Symptoms (from Screenshot):**

* **Needs:** Energy, Hunger, and Social are at 0%.  
* **Emotions:** Mood is at \-100% and Stress is at 100%.  
* **Inventory:** Agent has 0 Food.  
* **Primary Goal:** "BECOME RICH" (aspiration) is the active goal.

**Root Cause Analysis:** The current Utility AI scoring in `actionScorer.js` creates a logic failure:

1. **Aspiration \> Survival:** The score for `fsm_working` (driven by the `BECOME_RICH` aspiration) is a high, constant value.  
2. **No Competition:** The scores for `fsm_sleeping`, `fsm_eating`, and `fsm_socializing` are calculated based on their respective needs (`Energy`, `Hunger`, `Social`).  
3. **The "Death Spiral":** Because agents' needs are not being fulfilled, they remain at 100 (high need). This *should* create a high score for sleeping/eating, but the `workScore` is *still* higher. The agents are logically (but incorrectly) choosing to work themselves to death because their aspiration provides a stronger motivation than their own survival.

The simulation is **feature-complete** for performance optimization and architecture. The **entire focus** must now shift to **AI behavioral design**.

## **4\. Consolidated Roadmap: Next Steps**

This roadmap merges `ROADMAP.md` and `ImplementationStatus.md` into a single, prioritized plan.

### **🔴 Tier 1: Critical (Fixes & Stability)**

* **AI BEHAVIORAL FIX:** Re-architect the `actionScorer.js` utility scoring.  
  * **Problem:** Aspirations (Work) are always out-scoring critical survival needs (Sleep, Eat).  
  * **Solution:** Implement a "Maslow's Hierarchy" model. High-stress or critical-need states (e.g., Energy \> 95\) must apply a massive, non-linear score multiplier, forcing them to override all other goals.  
* **Item \#33 (Unit Tests):** Write Jest tests for the AI scoring logic to prevent future regressions.  
* **Item \#11 (Circular Dependency):** Break the `agent.js` \-\> `fsm.js` \-\> `actionScorer.js` \-\> `agent.js` import cycle.  
* **Item \#21 (JSON Serialization):** Migrate `JSON.parse(JSON.stringify())` to use SQLite's native JSON1 extension.  
* **Item \#34 (Magic Numbers):** Move all "magic numbers" (e.g., `stress > 0.75`, `energyRegen = 5.0`) into `config.js` so they can be balanced easily.  
* **Item \#35 & \#36 (Code Quality):** Introduce type safety (JSDoc/TypeScript) and standardize error handling.

### **🟡 Tier 2: High Value (Immersion & AI)**

* **Item \#26 (Multi-Step Planning):** Implement a "Goal Stack" or planner.  
  * **Problem:** Agents only plan 1 action ahead (e.g., `eat`).  
  * **Solution:** An agent's goal should be "I'm hungry," which generates a plan: `[fsm_commuting (to store), fsm_shopping, fsm_commuting (to home), fsm_eating]`. (Ref: `ROADMAP` P2, Item 2\)  
* **Item \#16 (Deeper Relationships):** Add memory to relationships.  
  * **Problem:** Affinity is just a number.  
  * **Solution:** Add a `history` array to relationships to track significant shared events (arguments, great conversations). (Ref: `ROADMAP` P2, Item 1\)  
* **Item \#17 (Personality Expression):** Make personality (extroversion, etc.) affect *more* than just AI scoring. It should change conversation choices, hobby preferences, and stress reactions.  
* **Item \#29 (Agent Inspector):** Create a UI modal to see an agent's full state: their top-scoring goal considerations, their current plan stack, and their recent memory log.  
* **Item \#30 (Time Controls):** Implement pause, play, and fast-forward controls in the dashboard. (Ref: `ROADMAP` P3, Item 2\)

### **🟢 Tier 3: Medium Value (Content & Features)**

* **Item \#19 (Item System):** Expand inventory beyond "food". Add items (books, tools, gifts) that can be purchased, used to fulfill recreation, or given to other agents.  
* **Item \#18 (Dynamic World):** Allow location affordances to change. (e.g., "Subway Strike" event increases all `travel_ticks`, "Construction" event invalidates a path).  
* **Item \#38 (Random Events):** Create a `worldService.js` function to trigger random agent-specific events (mugging, illness, lottery win) that create emergent stories.  
* **Item \#31 & \#32 (Debug UI):** Add UI filters to reduce log spam and add visual overlays for pathfinding or social networks.

### **🔵 Tier 4: Future Vision (V2.0)**

* **Item \#1 (GOAP/Behavior Trees):** A full refactor of the AI system, moving from a Utility FSM to a formal Goal-Oriented Action Planning system. This is the long-term solution for complex, multi-step plans. (Ref: `ROADMAP` P5, Item 1\)  
* **Item \#40 (Progression System):** Add long-term goals, achievements, and generational simulation (agents age, retire, and are replaced).  
* **Item \#37 (Moddability):** Refactor activities to be 100% defined in YAML, allowing new activities to be added without touching engine code.

