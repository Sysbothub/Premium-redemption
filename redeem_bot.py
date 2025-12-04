import os
import random
import string
import threading
import time # Added for the main loop sleep
from datetime import datetime

# Discord and MongoDB Libraries
import discord
from discord.ext import commands
from pymongo import MongoClient

# Web Server Library (for Render health check)
from flask import Flask, jsonify

# --- Configuration ---
# Expects a comma-separated string of tokens from the environment variable.
BOT_TOKENS_STR = os.environ.get("DISCORD_BOT_TOKENS", "YOUR_TOKEN_1,YOUR_TOKEN_2")
BOT_TOKENS = [token.strip() for token in BOT_TOKENS_STR.split(',') if token.strip()]

MONGO_URI = os.environ.get("MONGO_URI", "mongodb://localhost:27017/")
OWNER_ID = int(os.environ.get("OWNER_ID", 1234567890))
DB_NAME = "DiscordBotDB"
PREFIX = "$"
PORT = int(os.environ.get("PORT", 3000))

# --- Database Setup (Shared across all bot instances) ---
try:
    client_mongo = MongoClient(MONGO_URI)
    db = client_mongo[DB_URI]
    codes_collection = db["redemption_codes"]
    config_collection = db["guild_configs"]
    print("Successfully connected to MongoDB.")
except Exception as e:
    print(f"Failed to connect to MongoDB: {e}")
    db = None 

# --- Database Utility Functions (Shared) ---

async def get_guild_config(guild_id: int):
    """Retrieves guild configuration from the database."""
    if not db: return {}
    config = config_collection.find_one({"_id": guild_id})
    return config if config else {"_id": guild_id, "vip_role_id": None, "redeeming_admin_id": None}

async def update_guild_config(guild_id: int, key: str, value):
    """Updates a specific key in the guild configuration."""
    if not db:
        print("DB connection not established. Cannot update config.")
        return
    config_collection.update_one(
        {"_id": guild_id},
        {"$set": {key: value}},
        upsert=True
    )

def generate_unique_code_sync(prefix: str, duration_days: int):
    """Generates a unique code, stores its duration, and saves it to the database (synchronous)."""
    if not db:
        raise Exception("DB connection not established. Cannot create code.")
    
    code_suffix = ''.join(random.choices(string.hexdigits.upper(), k=12))
    full_code = f"{code_suffix}"
    
    # Store the duration in days
    codes_collection.insert_one({
        "code": full_code,
        "prefix": prefix,
        "duration_days": duration_days, # NEW: Duration in days
        "redeemed": False,
        "redeemed_by_user_id": None,
        "redeemed_at_guild_id": None,
        "redeemed_timestamp": None
    })
    return full_code, duration_days # Return both for command response

# --- Bot Commands (Refactored into a Cog) ---

class PremiumRedeemer(commands.Cog):
    def __init__(self, bot):
        self.bot = bot

    @commands.Cog.listener()
    async def on_ready(self):
        """Confirms bot readiness."""
        print(f"Bot instance logged in as {self.bot.user.name} (ID: {self.bot.user.id})")
        await self.bot.change_presence(activity=discord.Game(name=f"{PREFIX}redeem"))

    @commands.command(name="genpremiumcode")
    async def generate_code(self, ctx, prefix: str, duration: str = "30d"):
        """
        (Owner Only) Generates a unique redemption code with a prefix and duration.
        Example: $genpremiumcode TestUser 90d
        """
        if ctx.author.id != OWNER_ID:
            await ctx.send("❌ Error: Only the bot owner can use this command.")
            return

        # 1. Parse and validate duration
        duration_days = 0
        duration_str = duration.lower().replace(' ', '')
        
        if duration_str.endswith('d'):
            try:
                duration_days = int(duration_str[:-1])
            except ValueError:
                await ctx.send("❌ Error: Invalid duration format. Use a number followed by 'd' (e.g., `90d`).")
                return
        else:
            await ctx.send("❌ Error: Duration must be specified in days (e.g., `30d`, `90d`).")
            return

        if duration_days <= 0:
            await ctx.send("❌ Error: Duration must be a positive number of days.")
            return

        try:
            # 2. Run the synchronous DB operation with duration
            # Returns the code and the parsed duration in days
            new_code, duration_days = await self.bot.loop.run_in_executor(None, generate_unique_code_sync, prefix, duration_days) 
            
            await ctx.send(f"✅ New premium code generated for prefix `{prefix}` with **{duration_days} days** duration: `{new_code}`. (Attempting to DM)")
            
            # Attempt to DM the code
            try:
                await ctx.author.send(f"Generated Code for Prefix `{prefix}` ({duration_days} days): `{new_code}`")
            except discord.errors.Forbidden:
                await ctx.send("⚠️ Warning: Could not DM the code. Please copy it from the channel immediately and delete this message.")
                
        except Exception as e:
            print(f"Error generating code: {e}")
            await ctx.send(f"❌ Error generating code: {e}")

    @commands.command(name="redeem")
    async def redeem_code(self, ctx, code: str):
        """Redeems a premium code and starts the role configuration process."""
        if not ctx.guild:
            await ctx.send("This command must be used in a server channel.")
            return
        if not db:
            await ctx.send("⚠️ The bot is still connecting to the database. Please try again in a moment.")
            return

        code_upper = code.upper()
        guild_id = ctx.guild.id
        user_id = ctx.author.id
        
        try:
            # 1. Check if the guild already has an active subscription/configuration
            config = await get_guild_config(guild_id)
            if config.get("vip_role_id"):
                await ctx.send(
                    "🚫 **Redeem Failed:** This server already has an active Premium Role configured. "
                    "Only one active subscription is allowed per server."
                )
                return

            # 2. Check and atomically redeem the code
            # Note: find_one_and_update is thread-safe for atomic operations
            result = codes_collection.find_one_and_update(
                {"code": code_upper, "redeemed": False},
                {"$set": {
                    "redeemed": True,
                    "redeemed_by_user_id": user_id,
                    "redeemed_at_guild_id": guild_id,
                    "redeemed_timestamp": datetime.utcnow()
                }},
                return_document=True 
            )

            if not result:
                await ctx.send(f"❌ Code `{code}` is invalid or has already been redeemed.")
                return
            
            # Retrieve duration for confirmation message
            duration_days = result.get("duration_days", "Unknown")

            # 3. Code is valid and redeemed. Save the user ID who redeemed it.
            await update_guild_config(guild_id, "redeeming_admin_id", user_id)
            
            # 4. Respond and prompt admin to configure the role
            await ctx.send(
                f"✅ **Code Redeemed Successfully!** (Duration: {duration_days} days)\n\n"
                f"You have successfully claimed the subscription for this server! "
                f"An Administrator must now run `{PREFIX}setpremiumrole <@Role>` "
                f"to select the VIP role and finalize the configuration. "
                f"This action records you as the official redeeming user."
            )

        except Exception as e:
            print(f"Error processing redeem code: {e}")
            await ctx.send(f"❌ An internal error occurred during redemption: {e}")

    @commands.command(name="setpremiumrole")
    @commands.has_permissions(administrator=True)
    async def set_premium_role(self, ctx, role: discord.Role):
        """(Admin Only) Sets the designated VIP role and assigns it to the redeeming user."""
        if not ctx.guild:
            return
        
        try:
            guild_id = ctx.guild.id
            
            # 1. Save the VIP role ID
            await update_guild_config(guild_id, "vip_role_id", role.id)
            
            # 2. Retrieve the ID of the user who ran the successful $redeem command
            config = await get_guild_config(guild_id)
            redeeming_user_id = config.get("redeeming_admin_id")
            
            response = f"✅ **Premium Role Configuration Saved!**\n\n"
            response += f"**Server:** `{ctx.guild.name}`\n"
            response += f"**Premium Role Set:** {role.mention} (`{role.id}`)\n"

            if not redeeming_user_id:
                response += "\n\n**Note:** Could not find the original redeeming user ID. Please ensure someone ran `$redeem` previously."
                await ctx.send(response)
                return

            # Note: fetch_member is asynchronous and required to ensure we get the latest member data
            redeeming_user = await ctx.guild.fetch_member(redeeming_user_id)
            response += f"**Redeeming Admin:** <@{redeeming_user_id}> (The user who ran `$redeem`)\n\n"
            
            # 3. Attempt to assign the role to the original redeeming user
            if redeeming_user:
                try:
                    await redeeming_user.add_roles(role)
                    response += "**Action:** Premium role assigned to the redeeming admin."
                except discord.Forbidden:
                    response += "**Warning:** I lack permissions (`Manage Roles`) to assign the role. Check role hierarchy (my role must be higher than the role being assigned)."
                except Exception as e:
                    response += f"**Error:** Failed to assign role to user: {e}"
            else:
                response += "**Note:** The original redeeming admin is no longer in this server."

            await ctx.send(response)

        except Exception as e:
            print(f"Error setting premium role for guild {ctx.guild.id}: {e}")
            await ctx.send(f"❌ Error setting the premium role: {e}")

    @commands.command(name="invite")
    async def invite(self, ctx):
        """Generates the invite link for this bot instance. (Public command)"""
        if not self.bot.user:
            await ctx.send("❌ Error: Bot user information is not yet available.")
            return

        # Permissions needed (Combined Integer: 268820352):
        # - Manage Roles (268435456)
        # - Manage Messages (8192)
        # - Read Message History (65536)
        # - Send Messages (2048)
        # - Send Files/Attach Files (32768)
        # - Send Embeds/Embed Links (16384)
        # - Use External Emojis (262144)
        # - Add Reactions (64) <- NEW
        PERMISSIONS_INT = 268820352 

        # Construct the OAuth2 URL
        client_id = self.bot.user.id
        invite_url = (
            f"https://discord.com/oauth2/authorize?client_id={client_id}"
            f"&permissions={PERMISSIONS_INT}&scope=bot+applications.commands"
        )

        await ctx.send(
            f"🔗 **{self.bot.user.name}'s Invite Link**\n\n"
            f"This link requests the following administrative and messaging permissions:\n"
            f"• Manage Roles\n"
            f"• Manage Messages\n"
            f"• Read Message History\n"
            f"• Send Messages, Embeds, Files, and External Emojis\n"
            f"• **Add Reactions**\n\n"
            f"<{invite_url}>"
        )
        

# --- Flask Web Server (Required for Render) ---
# Note: This is an internal health check and does not interact with the bots directly.
app = Flask(__name__)
# Keep a list of all bot instances to check readiness
active_bots = [] 

@app.route("/")
def health_check():
    """Simple health check route for Render."""
    ready_bots = sum(1 for bot_instance in active_bots if bot_instance.is_ready())
    
    return jsonify({
        "status": "running",
        "ready_bots": ready_bots,
        "total_bots": len(active_bots),
        "message": f"Discord Bot Service is running. {ready_bots}/{len(active_bots)} bots are ready."
    })

def run_flask():
    """Runs the Flask application in a separate thread."""
    app.run(host='0.0.0.0', port=PORT)

def run_bot(token):
    """Initializes and runs a single Discord bot instance."""
    # Ensure all required intents are active for member/guild operations
    intents = discord.Intents.default()
    intents.message_content = True
    intents.members = True
    intents.guilds = True
    
    bot_instance = commands.Bot(command_prefix=PREFIX, intents=intents)
    active_bots.append(bot_instance) # Track for health check
    
    # Add the command and event logic (Cog) to the new bot instance
    bot_instance.add_cog(PremiumRedeemer(bot_instance))
    
    try:
        bot_instance.run(token)
    except Exception as e:
        print(f"An error occurred while running a bot instance: {e}")
        # Clean up the failed bot instance from the list
        if bot_instance in active_bots:
            active_bots.remove(bot_instance)

# --- Main Execution ---
if __name__ == "__main__":
    # 1. Start Flask web server in a background thread
    threading.Thread(target=run_flask, daemon=True).start()
    
    # 2. Start each Discord bot in its own background thread
    if not BOT_TOKENS:
        print("❌ Error: No bot tokens found in the DISCORD_BOT_TOKENS environment variable.")
    else:
        print(f"Starting {len(BOT_TOKENS)} Discord bot instance(s)...")
        for token in BOT_TOKENS:
            bot_thread = threading.Thread(target=run_bot, args=(token,), daemon=True)
            bot_thread.start()
    
    # Keep the main thread alive indefinitely since the bot threads are running in the background.
    # The Flask thread will satisfy the web service requirement of Render.
    while True:
        try:
            # Sleep briefly to reduce CPU usage
            time.sleep(1) 
        except KeyboardInterrupt:
            print("Shutting down...")
            break
