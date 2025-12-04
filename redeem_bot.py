import os
import random
import string
import threading
import time
from datetime import datetime, timedelta

# Discord and MongoDB Libraries
import discord
from discord.ext import commands, tasks
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

# Dedicated channel ID for logging redemption, configuration, and expiry events
# NOTE: Read from ENV for easy configuration. Ensure this is set correctly in Render.
LOG_CHANNEL_ID = os.environ.get("LOG_CHANNEL_ID", 0) 
try:
    LOG_CHANNEL_ID = int(LOG_CHANNEL_ID)
except ValueError:
    LOG_CHANNEL_ID = 0 # Default to 0 if not set or invalid

# --- Database Setup (Shared across all bot instances) ---
try:
    client_mongo = MongoClient(MONGO_URI)
    db = client_mongo[DB_NAME]
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
    # Ensure all required fields exist or are None/default
    if config:
        return config
    return {
        "_id": guild_id, 
        "vip_role_id": None, 
        "redeeming_admin_id": None, 
        "subscription_end_date": None,
        "expiry_notified_1d": False, # Flag for 1-day warning
        "expiry_notified_final": False # Flag for final expiration
    }

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
        "duration_days": duration_days, 
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
        # NOTE: Removed task startup from __init__ to prevent "no running event loop" error.
        # It is now started in on_ready.

    def cog_unload(self):
        """Ensure the background task is cancelled when the Cog is unloaded."""
        self.check_expirations.cancel()

    async def send_log_embed(self, title: str, description: str, color: discord.Color, fields: list = None):
        """Helper function to send a structured log message to the dedicated channel."""
        if not LOG_CHANNEL_ID:
            print("LOG_CHANNEL_ID is not configured. Skipping log.")
            return

        try:
            # Use get_channel (cached) and fall back to fetch_channel if not found
            log_channel = self.bot.get_channel(LOG_CHANNEL_ID)
            if not log_channel:
                log_channel = await self.bot.fetch_channel(LOG_CHANNEL_ID)
            
            if not log_channel:
                print(f"Error: Log channel with ID {LOG_CHANNEL_ID} not found.")
                return

            embed = discord.Embed(
                title=title,
                description=description,
                color=color,
                timestamp=datetime.utcnow()
            )
            
            if fields:
                for name, value, inline in fields:
                    embed.add_field(name=name, value=value, inline=inline)
            
            embed.set_footer(text=f"Bot Instance: {self.bot.user.name}")
            
            await log_channel.send(embed=embed)

        except Exception as e:
            print(f"Error sending log message to Discord: {e}")

    @commands.Cog.listener()
    async def on_ready(self):
        """Confirms bot readiness and starts the background task."""
        print(f"Bot instance logged in as {self.bot.user.name} (ID: {self.bot.user.id})")
        await self.bot.change_presence(activity=discord.Game(name=f"{PREFIX}redeem"))
        
        # FIX: Start the background task here, where the asyncio event loop is guaranteed to be running.
        if not self.check_expirations.is_running():
            self.check_expirations.start()

    @tasks.loop(hours=6) # Check every 6 hours
    async def check_expirations(self):
        """Background task to check for expiring and expired subscriptions."""
        if not db or not self.bot.is_ready():
            return

        utcnow = datetime.utcnow()
        one_day_ahead = utcnow + timedelta(days=1)

        # Query for all configured guilds that have an expiration date set
        subscriptions = config_collection.find({
            "subscription_end_date": {"$ne": None},
        })

        for sub in subscriptions:
            guild_id = sub["_id"]
            vip_role_id = sub.get("vip_role_id")
            expiry_date = sub["subscription_end_date"]
            redeeming_admin_id = sub.get("redeeming_admin_id")
            guild = self.bot.get_guild(guild_id)

            # 1. FINAL EXPIRY (Subscription has passed)
            if expiry_date < utcnow and not sub.get("expiry_notified_final"):
                
                role_removed = "N/A (Role not set or admin ID missing)"
                
                if guild and vip_role_id and redeeming_admin_id:
                    member = guild.get_member(redeeming_admin_id)
                    role = guild.get_role(vip_role_id)
                    
                    if member and role:
                        try:
                            # Attempt to remove the role
                            await member.remove_roles(role, reason="Premium Subscription Expired")
                            role_removed = "✅ Role Removed"
                        except discord.Forbidden:
                            role_removed = "❌ Forbidden (Missing 'Manage Roles' permission)"
                        except Exception as e:
                            role_removed = f"❌ Error: {e}"
                    elif not member:
                        role_removed = "⚠️ Redeeming Admin not found in guild"
                    elif not role:
                        role_removed = "⚠️ VIP Role not found in guild"

                # Send FINAL EXPIRATION Log
                await self.send_log_embed(
                    title="🔴 SUBSCRIPTION EXPIRED",
                    description=f"Subscription for server **{guild.name if guild else f'ID: {guild_id}'}** has expired and role removal was attempted.",
                    color=discord.Color.red(),
                    fields=[
                        ("Server Name/ID", f"{guild.name if guild else 'N/A'} (`{guild_id}`)", False),
                        ("Redeeming Admin ID", f"`{redeeming_admin_id}`", True),
                        ("Expired On (UTC)", expiry_date.strftime("%Y-%m-%d %H:%M UTC"), True),
                        ("Role ID", f"`{vip_role_id}`", True),
                        ("Role Action", role_removed, True),
                    ]
                )
                
                # Set flag to prevent future final notifications
                await update_guild_config(guild_id, "expiry_notified_final", True)


            # 2. 1-DAY WARNING (Subscription expires within the next 24 hours)
            elif expiry_date < one_day_ahead and expiry_date >= utcnow and not sub.get("expiry_notified_1d"):
                
                # Send 1-DAY WARNING Log
                await self.send_log_embed(
                    title="🟠 SUBSCRIPTION EXPIRING SOON (24H)",
                    description=f"Subscription for server **{guild.name if guild else f'ID: {guild_id}'}** expires within 24 hours.",
                    color=discord.Color.orange(),
                    fields=[
                        ("Server Name/ID", f"{guild.name if guild else 'N/A'} (`{guild_id}`)", False),
                        ("Redeeming Admin ID", f"`{redeeming_admin_id}`", True),
                        ("Expires On (UTC)", expiry_date.strftime("%Y-%m-%d %H:%M UTC"), True),
                    ]
                )
                
                # Set flag to prevent duplicate 1-day notifications
                await update_guild_config(guild_id, "expiry_notified_1d", True)


    @check_expirations.before_loop
    async def before_check_expirations(self):
        """Wait until the bot is connected before starting the loop."""
        await self.bot.wait_until_ready()

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
                # Check if subscription is expired before failing redemption
                if config.get("subscription_end_date") and config["subscription_end_date"] > datetime.utcnow():
                    await ctx.send(
                        "🚫 **Redeem Failed:** This server already has an active Premium Role configured. "
                        "Only one active subscription is allowed per server."
                    )
                    return

            # 2. Check and atomically redeem the code
            redeemed_time = datetime.utcnow()
            result = codes_collection.find_one_and_update(
                {"code": code_upper, "redeemed": False},
                {"$set": {
                    "redeemed": True,
                    "redeemed_by_user_id": user_id,
                    "redeemed_at_guild_id": guild_id,
                    "redeemed_timestamp": redeemed_time
                }},
                return_document=True 
            )

            if not result:
                await ctx.send(f"❌ Code `{code}` is invalid or has already been redeemed.")
                return
            
            duration_days = result.get("duration_days", 0)
            
            # 3. Calculate Expiry and Store Initial Config 
            expiry_date = redeemed_time + timedelta(days=duration_days)
            
            # Store subscription metadata in guild config
            config_collection.update_one(
                {"_id": guild_id},
                {"$set": {
                    "redeeming_admin_id": user_id,
                    "subscription_end_date": expiry_date,
                    # Reset flags for new subscription
                    "expiry_notified_1d": False,
                    "expiry_notified_final": False,
                }},
                upsert=True
            )

            # 4. Log the successful redemption 
            await self.send_log_embed(
                title="✅ PREMIUM CODE REDEEMED",
                description="A unique code has been claimed, starting the configuration process for a server.",
                color=discord.Color.green(),
                fields=[
                    ("Code", f"`{code_upper}` (Prefix: `{result.get('prefix', 'N/A')}`)", True),
                    ("Duration", f"{duration_days} days", True),
                    ("Expires On (UTC)", expiry_date.strftime("%Y-%m-%d %H:%M UTC"), True),
                    ("Server Name", f"{ctx.guild.name} (`{guild_id}`)", False),
                    ("Redeeming User", f"{ctx.author.mention} (`{user_id}`)", False),
                ]
            )
            
            # 5. Respond and prompt admin to configure the role
            await ctx.send(
                f"✅ **Code Redeemed Successfully!** (Duration: {duration_days} days)\n\n"
                f"Subscription expires on: **{expiry_date.strftime('%Y-%m-%d')} UTC**\n\n"
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
            expiry_date = config.get("subscription_end_date")
            
            response = f"✅ **Premium Role Configuration Saved!**\n\n"
            response += f"**Server:** `{ctx.guild.name}`\n"
            response += f"**Premium Role Set:** {role.mention} (`{role.id}`)\n"
            response += f"**Subscription End Date:** {expiry_date.strftime('%Y-%m-%d %H:%M UTC') if expiry_date else 'N/A'}\n"


            if not redeeming_user_id:
                response += "\n\n**Note:** Could not find the original redeeming user ID. Please ensure someone ran `$redeem` previously."
                await ctx.send(response)
                return

            # Note: fetch_member is asynchronous and required to ensure we get the latest member data
            redeeming_user = await ctx.guild.fetch_member(redeeming_user_id)
            response += f"**Redeeming Admin:** <@{redeeming_user_id}> (The user who ran `$redeem`)\n\n"
            
            # 3. Attempt to assign the role to the original redeeming user
            role_assigned = False
            if redeeming_user:
                try:
                    await redeeming_user.add_roles(role)
                    response += "**Action:** Premium role assigned to the redeeming admin."
                    role_assigned = True
                except discord.Forbidden:
                    response += "**Warning:** I lack permissions (`Manage Roles`) to assign the role. Check role hierarchy (my role must be higher than the role being assigned)."
                except Exception as e:
                    response += f"**Error:** Failed to assign role to user: {e}"
            else:
                response += "**Note:** The original redeeming admin is no longer in this server."

            # 4. Log the role configuration completion
            await self.send_log_embed(
                title="⭐ SERVER PREMIUM CONFIGURATION COMPLETE",
                description=f"The premium role has been set for the server and assigned to the Redeeming Admin.",
                color=discord.Color.gold(),
                fields=[
                    ("Server Name", f"{ctx.guild.name} (`{guild_id}`)", False),
                    ("Premium Role", f"{role.mention} (`{role.id}`)", True),
                    ("Expires On (UTC)", expiry_date.strftime("%Y-%m-%d %H:%M UTC") if expiry_date else 'N/A', True),
                    ("Redeeming Admin", f"<@{redeeming_user_id}> (`{redeeming_user_id}`)", True),
                    ("Role Assigned?", "✅ Yes" if role_assigned else "❌ No (Permissions/User Error)", True),
                    ("Configuring Admin", f"{ctx.author.mention}", False),
                ]
            )

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
        # Read Messages, Send Messages, Manage Roles
        PERMISSIONS_INT = 268820352 

        # Construct the OAuth2 URL
        client_id = self.bot.user.id
        invite_url = (
            f"https://discord.com/oauth2/authorize?client_id={client_id}"
            f"&permissions={PERMISSIONS_INT}&scope=bot+applications.commands"
        )

        await ctx.send(
            f"🔗 **{self.bot.user.name}'s Invite Link**\n\n"
            f"This link requests the necessary permissions. "
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
    # Use the port defined in ENV or default to 3000
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
    while True:
        try:
            # Sleep briefly to reduce CPU usage
            time.sleep(1) 
        except KeyboardInterrupt:
            print("Shutting down...")
            break
