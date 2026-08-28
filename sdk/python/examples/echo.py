import os

from atalk import Agent

agent = Agent(token=os.environ["AGENT_TOKEN"], base_url=os.getenv("ATALK_BASE_URL", "http://127.0.0.1:4001"))


@agent.on_message
async def handle(message):
    await message.reply("Hello human!")


agent.run()
