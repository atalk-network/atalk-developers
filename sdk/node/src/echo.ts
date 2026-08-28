import { Agent } from "./agent.js";

const token = process.env.AGENT_TOKEN;
if (!token) throw new Error("Set AGENT_TOKEN to the one-time token shown by aTalk");

const baseUrl = process.env.ATALK_BASE_URL;
const agent = new Agent({ token, ...(baseUrl ? { baseUrl } : {}) });
agent.on("message", async (message) => {
  await message.reply("Hello human!");
});
agent.on("error", (error) => console.error(error.message));

await agent.start();
console.log("aTalk echo agent connected");
