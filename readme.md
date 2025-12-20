NYC 1999 Simulator - Priority 8 (Economy & World Clock)

This is a major update that adds the foundational layer for a "society": a World Clock and a basic Economy.

Agents are no longer just driven by basic needs; they are now driven by a schedule and the need to earn money to survive.

CRITICAL: Database Migration

This update adds a money column to the agents table. The old database file is now incompatible.

You MUST delete your nyc_1999.db file before running this version.

What's New

World Clock: The simulation now tracks time. Each tick advances the clock (e.g., 1 tick = 10 minutes). The current Day and Time are shown in the "Simulation Status" panel.

Money: Agents now have a money property, visible in the "Active Agents" log (e.g., $: 100).

Work: Agents have a WORKING state. During "work hours" (9:00 - 17:00), agents who need money and are at a WORK location (like OFFICE_MIDTOWN) will choose to work, earning a salary every tick.

Cost of Living: The EAT action now costs money. Agents will check if they can afford to eat before doing so.

Smarter Brains: All brains (LOD 1 Rules, LOD 1 LLM, and LOD 2 Background) have been updated to understand this new economic model.

New Location: Added a GROCERY_STORE as another place agents can EAT.

How to Run

DELETE YOUR OLD DATABASE:

Find and delete the nyc_1999.db file in your project folder.

Install Dependencies (No new ones, but good practice):

npm install


Pull & Run Ollama (Mandatory):

In a separate terminal, ensure your Ollama server is running with the correct model:

ollama run llama3:latest


Configure Metasim (Recommended):

Open config.js and set the METASIM_AGENT_NAMES array to include just one agent you want to observe.

Run the Simulation:

npm start


What to Observe

Watch the new World Time in the "Simulation Status" panel.

Observe agent money ($:).

Use the arrow keys to focus on OFFICE_MIDTOWN. When the clock strikes 9:00, watch agents (especially those with low money) enter the WORKING state.

Focus on APARTMENT_HK or GROCERY_STORE. Watch hungry agents' money decrease when they decide to EAT.

This creates the full loop: agents will get hungry, spend money to eat, see their money go down, and then be motivated to go to work to earn it back.