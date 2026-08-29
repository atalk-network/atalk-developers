import os

from atalk import Agent

agent = Agent(token=os.environ["AGENT_TOKEN"], base_url=os.getenv("ATALK_BASE_URL", "http://127.0.0.1:4001"))


@agent.on_message
async def handle(message):
    if message.is_supervisor:
        await message.relay(message.text)
        return
    await message.reply("Hello human!")


@agent.on_error
async def handle_error(error):
    print(f"aTalk runtime error: {error}")


agent.run()
