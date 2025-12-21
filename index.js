// BLOCK 1: IMPORTS & SETUP
const { Client, GatewayIntentBits, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const express = require('express');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
require('dotenv').config();

// BLOCK 2: INITIALIZE CLIENT & EXPRESS
const client = new Client({ 
  intents: [
    GatewayIntentBits.Guilds, 
    GatewayIntentBits.GuildMessages, 
    GatewayIntentBits.MessageContent, 
    GatewayIntentBits.DirectMessages
  ] 
});
const app = express();
const PREFIX = process.env.PREFIX || '!';

// BLOCK 3: MIDDLEWARE
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// BLOCK 4: MONGODB CONNECTION
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => {
  console.log('✅ Connected to MongoDB');
}).catch((err) => {
  console.error('❌ MongoDB connection error:', err);
  process.exit(1);
});

// BLOCK 5: MONGODB SCHEMAS
const codeSchema = new mongoose.Schema({
  code: { type: String, unique: true, required: true },
  premiumDays: { type: Number, default: 31 },
  maxUses: { type: Number, default: 1 },
  currentUses: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true },
  createdBy: String,
  createdAt: { type: Date, default: Date.now }
});

const guildPremiumSchema = new mongoose.Schema({
  guildId: { type: String, unique: true, required: true },
  premiumRoleId: String,
  premiumExpiresAt: Date,
  redeemedCodes: [String],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const voteSchema = new mongoose.Schema({
  userId: { type: String, unique: true, required: true },
  username: String,
  totalVotes: { type: Number, default: 0 },
  lastVoteAt: Date,
  votedAt: [Date],
  createdAt: { type: Date, default: Date.now }
});

// BLOCK 6: MODELS
const Code = mongoose.model('Code', codeSchema);
const GuildPremium = mongoose.model('GuildPremium', guildPremiumSchema);
const Vote = mongoose.model('Vote', voteSchema);

// BLOCK 7: HELPER FUNCTIONS
async function checkAndRemovePremium() {
  try {
    const expiredPremiums = await GuildPremium.find({ premiumExpiresAt: { $lt: new Date() } });
    
    for (const premium of expiredPremiums) {
      const guild = await client.guilds.fetch(premium.guildId).catch(() => null);
      
      if (guild && premium.premiumRoleId) {
        try {
          const role = await guild.roles.fetch(premium.premiumRoleId);
          const members = await guild.members.fetch();
          
          for (const member of members.values()) {
            if (member.roles.has(premium.premiumRoleId)) {
              await member.roles.remove(premium.premiumRoleId);
            }
          }
          
          console.log(`✅ Removed expired premium from ${guild.name}`);
        } catch (error) {
          console.error(`❌ Error removing premium from ${premium.guildId}:`, error.message);
        }
      }
      
      await GuildPremium.deleteOne({ _id: premium._id });
    }
  } catch (error) {
    console.error('❌ Premium check error:', error);
  }
}

// BLOCK 8: BOT READY EVENT
client.once('ready', async () => {
  console.log(`✅ Bot is online as ${client.user.tag}`);
  
  await checkAndRemovePremium();
  
  setInterval(checkAndRemovePremium, 3600000);
  
  client.user.setActivity(`Pokemon`, { type: 'WATCHING' });
});

// BLOCK 9: MESSAGE CREATE EVENT
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const commandName = args.shift().toLowerCase();

  try {
    // BLOCK 10: HELP COMMAND
    if (commandName === 'help') {
      const helpEmbed = new EmbedBuilder()
        .setColor('#0099ff')
        .setTitle('📖 Miradion Premium Redemption commands')
        .addFields(
          { name: '🗳️ Vote Commands', value: '`!vote` - Get voting link', inline: false },
          { name: '💳 Premium Commands', value: '`!redeem <code>` - Redeem premium code\n`!premium` - Check premium status', inline: false },
          { name: '⚙️ Utility Commands', value: '`!ping` - Bot latency\n`!support` - Support server link', inline: false }
        )
        .setFooter({ text: 'Miraidon Premium Redemption Bot' })
        .setTimestamp();

      return message.reply({ embeds: [helpEmbed], allowedMentions: { repliedUser: false } });
    }

    // BLOCK 11: VOTE COMMAND
    if (commandName === 'vote') {
      const voteEmbed = new EmbedBuilder()
        .setColor('#FFD700')
        .setTitle('🗳️ Vote for Our Bot!')
        .setDescription('Vote on Top.gg to support us and get rewarded')
        .addFields(
          { name: '🔗 Vote Link', value: `https://top.gg/bot/${client.user.id}/vote`, inline: false },
          { name: '⏰ Vote Every 12 Hours', value: 'Come back after 12 hours to vote again!', inline: false },
          { name: '🎁 Rewards', value: 'Get entered into a bimonthly draw for a $25 Amazon Giftcard!', inline: false },
          { name: ':bar_chart: Vote Leaderboard', value: 'View the Leaderboard at: https://vote.miraidon.ca', inline: false }
        )
        .setFooter({ text: 'Miraidon Trade Bot' })
        .setTimestamp();

      return message.reply({ embeds: [voteEmbed], allowedMentions: { repliedUser: false } });
    }

    // BLOCK 12: TOP VOTERS COMMAND
    if (commandName === 'topvoters') {
      const topVoters = await Vote.find().sort({ totalVotes: -1 }).limit(10);

      if (topVoters.length === 0) {
        return message.reply({
          content: '❌ No votes yet.',
          allowedMentions: { repliedUser: false }
        });
      }

      let voterList = '';
      topVoters.forEach((voter, index) => {
        voterList += `${index + 1}. <@${voter.userId}> - ${voter.totalVotes} votes\n`;
      });

      const topVotersEmbed = new EmbedBuilder()
        .setColor('#FFD700')
        .setTitle('🏆 Top 10 Voters')
        .setDescription(voterList)
        .setFooter({ text: 'Miraidon Trade bot' })
        .setTimestamp();

      return message.reply({ embeds: [topVotersEmbed], allowedMentions: { repliedUser: false } });
    }

    // BLOCK 13: PREMIUM COMMAND
    if (commandName === 'premium') {
      const guildPremium = await GuildPremium.findOne({ guildId: message.guildId });

      if (!guildPremium || new Date() > guildPremium.premiumExpiresAt) {
        const premiumEmbed = new EmbedBuilder()
          .setColor('#FF0000')
          .setTitle('❌ Premium Not Active')
          .setDescription('This server does not have premium access.')
          .addFields(
            { name: '💳 How to Get Premium?', value: `Use \`${PREFIX}redeem <code>\` to activate premium`, inline: false },
            { name: '🗳️ Purchase Premium', value: `Head to our Webstore [Premium Shop](https://miraidon.sell.app) to get codes!`, inline: false }
          )
          .setFooter({ text: 'Miraidon Premium Redemption Bot' })
          .setTimestamp();

        return message.reply({ embeds: [premiumEmbed], allowedMentions: { repliedUser: false } });
      }

      const expiresIn = Math.ceil((guildPremium.premiumExpiresAt - new Date()) / (1000 * 60 * 60 * 24));

      const premiumEmbed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('✅ Premium Active')
        .setDescription('This server has premium access!')
        .addFields(
          { name: '⏰ Expires In', value: `${expiresIn} days`, inline: true },
          { name: '📅 Expiry Date', value: `<t:${Math.floor(guildPremium.premiumExpiresAt.getTime() / 1000)}:f>`, inline: true },
          { name: '🎯 Premium Role', value: `<@&${guildPremium.premiumRoleId}>`, inline: false },
          { name: '🎫 Codes Used', value: guildPremium.redeemedCodes.length.toString(), inline: true }
        )
        .setFooter({ text: 'Miraidon Premium Redemption Bot' })
        .setTimestamp();

      return message.reply({ embeds: [premiumEmbed], allowedMentions: { repliedUser: false } });
    }

    // BLOCK 14: CREATE CODE COMMAND (ADMIN ONLY) - IMPROVED
if (commandName === 'createcode') {
  if (message.author.id !== process.env.ADMIN_USER_ID) {
    return message.reply({
      content: '❌ Only admins can create codes.',
      allowedMentions: { repliedUser: false }
    });
  }

  // Parse arguments: !createcode [quantity] [premiumDays] [prefix]
  const quantity = parseInt(args[0]) || 1;
  const premiumDays = parseInt(args[1]) || 31;
  const codePrefix = args[2]?.toUpperCase() || 'PREM';

  // Validate quantity
  if (isNaN(quantity) || quantity < 1 || quantity > 100) {
    return message.reply({
      content: '❌ Quantity must be between 1 and 100. Usage: `!createcode [qty] [days] [prefix]`',
      allowedMentions: { repliedUser: false }
    });
  }

  // Validate days
  if (premiumDays < 1 || premiumDays > 3650) {
    return message.reply({
      content: '❌ Premium days must be between 1 and 3650.',
      allowedMentions: { repliedUser: false }
    });
  }

  try {
    const generatedCodes = [];
    const failedCodes = [];

    // Generate codes
    for (let i = 1; i <= quantity; i++) {
      // Create unique random code
      const randomPart = Math.random().toString(36).substring(2, 12).toUpperCase();
      const timestamp = Date.now().toString(36).toUpperCase().slice(-4);
      const codeString = `${codePrefix}-${timestamp}-${randomPart}`;

      try {
        const newCode = new Code({
          code: codeString,
          premiumDays,
          maxUses: 1,
          createdBy: message.author.id
        });

        await newCode.save();
        generatedCodes.push(codeString);
        console.log(`✅ Code created: ${codeString}`);
      } catch (error) {
        failedCodes.push(codeString);
        console.error(`❌ Failed to create code: ${codeString}`, error.message);
      }
    }

    // Create result embed for Discord
    const successCount = generatedCodes.length;
    const failCount = failedCodes.length;

    const codeEmbed = new EmbedBuilder()
      .setColor(successCount > 0 ? '#00FF00' : '#FF0000')
      .setTitle(successCount > 0 ? '✅ Codes Generated' : '❌ Code Generation Failed')
      .addFields(
        { name: '📊 Created', value: successCount.toString(), inline: true },
        { name: '❌ Failed', value: failCount.toString(), inline: true },
        { name: '⏳ Duration', value: `${premiumDays} days`, inline: true },
        { name: '🎯 Prefix', value: codePrefix, inline: true },
        { name: '📋 Preview (First 5)', value: generatedCodes.slice(0, 5).join('\n') || 'None', inline: false }
      )
      .setFooter({ text: 'Premium Redemption Bot' })
      .setTimestamp();

    await message.reply({ embeds: [codeEmbed], allowedMentions: { repliedUser: false } });

    // Send full code list via DM
    if (generatedCodes.length > 0) {
      const codeList = generatedCodes.join('\n');
      
      const dmEmbed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('🎫 Generated Premium Codes')
        .addFields(
          { name: '📊 Total Codes', value: successCount.toString(), inline: true },
          { name: '⏳ Duration Each', value: `${premiumDays} days`, inline: true },
          { name: '🎯 Prefix Used', value: codePrefix, inline: true },
          { name: '📋 All Codes', value: `\`\`\`\n${codeList}\n\`\`\``, inline: false }
        )
        .setFooter({ text: 'Premium Redemption Bot - Copy these codes for distribution' })
        .setTimestamp();

      try {
        await message.author.send({ embeds: [dmEmbed] });
        console.log(`✅ DM sent to ${message.author.tag} with ${successCount} codes`);
      } catch (error) {
        console.log(`⚠️ Could not DM codes to user: ${error.message}`);
        return message.reply({
          content: '⚠️ Codes created but DM failed. Check your DM settings.',
          allowedMentions: { repliedUser: false }
        });
      }
    }

  } catch (error) {
    console.error('❌ Code generation error:', error);
    return message.reply({
      content: '❌ An error occurred while generating codes.',
      allowedMentions: { repliedUser: false }
    });
  }
}

    // BLOCK 15: REDEEM COMMAND
    if (commandName === 'redeem') {
      if (!args[0]) {
        return message.reply({
          content: `❌ Usage: ${PREFIX}redeem <code>`,
          allowedMentions: { repliedUser: false }
        });
      }

      const codeInput = args[0].toUpperCase();
      const guildId = message.guildId;

      let guildPremium = await GuildPremium.findOne({ guildId });

      if (!guildPremium) {
        guildPremium = new GuildPremium({ guildId });
      }

      if (guildPremium.redeemedCodes.includes(codeInput)) {
        return message.reply({
          content: '❌ This code has already been redeemed for this server!',
          allowedMentions: { repliedUser: false }
        });
      }

      const premiumCode = await Code.findOne({ code: codeInput, isActive: true });

      if (!premiumCode) {
        return message.reply({
          content: '❌ Invalid or inactive code.',
          allowedMentions: { repliedUser: false }
        });
      }

      if (premiumCode.currentUses >= premiumCode.maxUses) {
        return message.reply({
          content: '❌ This code has already been used.',
          allowedMentions: { repliedUser: false }
        });
      }

      const modal = new ModalBuilder()
        .setCustomId(`premiumModal_${codeInput}`)
        .setTitle('Redeem Premium Code')
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('roleId')
              .setLabel('Premium Role ID')
              .setStyle(TextInputStyle.Short)
              .setPlaceholder('Paste the role ID here')
              .setRequired(true)
          )
        );

      await message.showModal(modal);
    }

    // BLOCK 16: VOTERINFO COMMAND
    if (commandName === 'voterinfo') {
      if (!args[0]) {
        return message.reply({
          content: `❌ Usage: ${PREFIX}voterinfo <userId>`,
          allowedMentions: { repliedUser: false }
        });
      }

      const userId = args[0].replace(/[<@!>]/g, '');
      const voteRecord = await Vote.findOne({ userId });

      if (!voteRecord) {
        return message.reply({
          content: '❌ This user has not voted yet.',
          allowedMentions: { repliedUser: false }
        });
      }

      const voteTimes = voteRecord.votedAt
        .slice(-5)
        .reverse()
        .map((date, index) => `${index + 1}. <t:${Math.floor(date.getTime() / 1000)}:f>`)
        .join('\n');

      const voterInfoEmbed = new EmbedBuilder()
        .setColor('#FFD700')
        .setTitle('🗳️ Voter Statistics')
        .addFields(
          { name: '👤 Username', value: voteRecord.username, inline: true },
          { name: '🆔 User ID', value: userId, inline: true },
          { name: '📊 Total Votes', value: voteRecord.totalVotes.toString(), inline: true },
          { name: '⏰ Last Vote', value: `<t:${Math.floor(voteRecord.lastVoteAt.getTime() / 1000)}:R>`, inline: true },
          { name: '📅 Last 5 Votes', value: voteTimes || 'No vote history', inline: false }
        )
        .setFooter({ text: 'Miraidon Trade Bot' })
        .setTimestamp();

      return message.reply({ embeds: [voterInfoEmbed], allowedMentions: { repliedUser: false } });
    }

    // BLOCK 17: SUPPORT COMMAND
    if (commandName === 'support') {
      const supportEmbed = new EmbedBuilder()
        .setColor('#0099ff')
        .setTitle('📞 Need Help?')
        .setDescription('Join our support server for assistance!')
        .addFields(
          { name: '🔗 Support Server', value: 'https://discord.gg/pkm-universe' }
        )
        .setFooter({ text: 'Miraidon Trading Bot' })
        .setTimestamp();

      return message.reply({ embeds: [supportEmbed], allowedMentions: { repliedUser: false } });
    }

    // BLOCK 18: PING COMMAND
    if (commandName === 'ping') {
      const ping = Date.now() - message.createdTimestamp;
      const apiPing = Math.round(client.ws.ping);

      const pingEmbed = new EmbedBuilder()
        .setColor('#0099ff')
        .setTitle('⏱️ Bot Latency')
        .addFields(
          { name: 'Message Latency', value: `${ping}ms`, inline: true },
          { name: 'API Latency', value: `${apiPing}ms`, inline: true }
        )
        .setFooter({ text: 'Miraidon Premium Reemtion bot' })
        .setTimestamp();

      return message.reply({ embeds: [pingEmbed], allowedMentions: { repliedUser: false } });
    }

    // BLOCK 19: UNKNOWN COMMAND HANDLER
    return message.reply({
      content: `❌ Unknown command! Use ${PREFIX}help for a list of commands.`,
      allowedMentions: { repliedUser: false }
    });

  } catch (error) {
    console.error('❌ Command error:', error);
    return message.reply({
      content: '❌ An error occurred while executing this command.',
      allowedMentions: { repliedUser: false }
    }).catch(() => {});
  }
});

// BLOCK 20: INTERACTION CREATE EVENT
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isModalSubmit()) return;

  try {
    const customId = interaction.customId;

    if (customId.startsWith('premiumModal_')) {
      const codeInput = customId.replace('premiumModal_', '');
      const roleId = interaction.fields.getTextInputValue('roleId');
      const guildId = interaction.guildId;

      // Validate role exists
      try {
        await interaction.guild.roles.fetch(roleId);
      } catch (err) {
        return interaction.reply({
          content: '❌ Role not found. Please provide a valid role ID.',
          ephemeral: true
        });
      }

      // Get or create guild premium
      let guildPremium = await GuildPremium.findOne({ guildId });

      if (!guildPremium) {
        guildPremium = new GuildPremium({ guildId });
      }

      // Check if code already redeemed
      if (guildPremium.redeemedCodes.includes(codeInput)) {
        return interaction.reply({
          content: '❌ This code has already been redeemed for this server!',
          ephemeral: true
        });
      }

      // Find code
      const premiumCode = await Code.findOne({ code: codeInput, isActive: true });

      if (!premiumCode) {
        return interaction.reply({
          content: '❌ Invalid or inactive code.',
          ephemeral: true
        });
      }

      // Check uses
      if (premiumCode.currentUses >= premiumCode.maxUses) {
        return interaction.reply({
          content: '❌ This code has already been used.',
          ephemeral: true
        });
      }

      // Calculate expiry
      const expiryDate = new Date();
      expiryDate.setDate(expiryDate.getDate() + premiumCode.premiumDays);

      // Update guild premium
      guildPremium.premiumRoleId = roleId;
      guildPremium.premiumExpiresAt = expiryDate;
      guildPremium.redeemedCodes.push(codeInput);
      guildPremium.updatedAt = new Date();
      await guildPremium.save();

      // Update code uses
      premiumCode.currentUses += 1;
      await premiumCode.save();

      // Log embed
      const premiumLogEmbed = new EmbedBuilder()
        .setColor('#00AAFF')
        .setTitle('🟦 Premium Activated')
        .addFields(
          { name: '📛 Server Name', value: interaction.guild.name, inline: true },
          { name: '🆔 Server ID', value: interaction.guild.id, inline: true },
          { name: '⏳ Duration', value: `${premiumCode.premiumDays} days`, inline: true },
          { name: '🎯 Role ID', value: roleId, inline: true },
          { name: '🎫 Code', value: codeInput, inline: true },
          { name: '👤 Redeemed By', value: `${interaction.user.tag}`, inline: false },
          { name: '⏰ Expires', value: `<t:${Math.floor(expiryDate.getTime() / 1000)}:f>`, inline: false }
        )
        .setDescription(`**Support:** https://discord.gg/pkm-universe`)
        .setFooter({ text: 'Miraidon Premium Logger' })
        .setTimestamp();

      // Send to log channel
      try {
        const supportServer = await client.guilds.fetch(process.env.SUPPORT_SERVER_ID).catch(() => null);
        if (supportServer) {
          const logChannel = await supportServer.channels.fetch(process.env.LOG_CHANNEL_ID).catch(() => null);
          if (logChannel && logChannel.isTextBased()) {
            await logChannel.send({ embeds: [premiumLogEmbed] });
            console.log(`✅ Premium activation logged for ${interaction.guild.name}`);
          }
        }
      } catch (error) {
        console.error('❌ Premium log failed:', error.message);
      }

      // Send DM to user
      try {
        const dmEmbed = new EmbedBuilder()
          .setColor('#00ff00')
          .setTitle('✅ Premium Activated!')
          .addFields(
            { name: '📛 Server', value: interaction.guild.name, inline: true },
            { name: '⏳ Duration', value: `${premiumCode.premiumDays} days`, inline: true },
            { name: '📅 Expires', value: `<t:${Math.floor(expiryDate.getTime() / 1000)}:f>`, inline: false },
            { name: '🎯 Role', value: `<@&${roleId}>`, inline: false }
          )
          .setFooter({ text: 'Miraidon Premium Redemption- NOTE Please allow upto 24 hours for the Bot to be updated to reflect premium status' })
          .setTimestamp();

        await interaction.user.send({ embeds: [dmEmbed] });
      } catch (error) {
        console.log(`⚠️ Could not DM user ${interaction.user.id}`);
      }

      // Send redeem response
      const redeemEmbed = new EmbedBuilder()
        .setColor('#00ff00')
        .setTitle('✅ Premium Activated for Server!')
        .addFields(
          { name: '🎫 Code', value: codeInput, inline: true },
          { name: '⏳ Duration', value: `${premiumCode.premiumDays} days`, inline: true },
          { name: '⏰ Expires', value: `<t:${Math.floor(expiryDate.getTime() / 1000)}:f>`, inline: false },
          { name: '🎯 Premium Role', value: `<@&${roleId}>`, inline: true },
          { name: '📍 Server', value: interaction.guild.name, inline: true }
        )
        .setFooter({ text: 'Miraidon Premium Redemption- NOTE Please allow upto 24 hours for the Bot to be updated to reflect premium status' })
        .setTimestamp();

      return interaction.reply({
        embeds: [redeemEmbed],
        ephemeral: false
      });
    }
  } catch (error) {
    console.error('❌ Modal handler error:', error);
    return interaction.reply({
      content: '❌ An error occurred while processing your request.',
      ephemeral: true
    }).catch(() => {});
  }
});

// BLOCK 21: EXPRESS ROUTES - STATUS
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    bot: client.user ? client.user.tag : 'Loading...',
    guilds: client.guilds.cache.size,
    users: client.users.cache.size
  });
});

app.get('/status', (req, res) => {
  res.json({
    status: 'online',
    uptime: process.uptime(),
    timestamp: new Date()
  });
});

// BLOCK 22: API ROUTES - CODES
app.get('/api/codes', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];

  if (!adminKey || adminKey !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  try {
    const codes = await Code.find();
    res.json({ success: true, count: codes.length, codes });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/codes/:codeParam', async (req, res) => {
  try {
    const codeParam = req.params.codeParam;
    const codeDoc = await Code.findOne({ code: codeParam });

    if (!codeDoc) {
      return res.status(404).json({ success: false, error: 'Code not found' });
    }

    res.json({
      success: true,
      code: codeDoc.code,
      premiumDays: codeDoc.premiumDays,
      maxUses: codeDoc.maxUses,
      currentUses: codeDoc.currentUses,
      isActive: codeDoc.isActive
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// BLOCK 23: API ROUTES - PREMIUM
app.get('/api/premium/server/:guildId', async (req, res) => {
  try {
    const guildId = req.params.guildId;
    const premium = await GuildPremium.findOne({ guildId });

    if (!premium) {
      return res.status(404).json({ success: false, error: 'No premium found' });
    }

    res.json({
      success: true,
      guildId: premium.guildId,
      premiumActive: new Date() < premium.premiumExpiresAt,
      premiumExpiresAt: premium.premiumExpiresAt,
      premiumRoleId: premium.premiumRoleId,
      redeemedCodesCount: premium.redeemedCodes.length
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/premium/servers', async (req, res) => {
  try {
    const premiums = await GuildPremium.find();
    res.json({ success: true, count: premiums.length, servers: premiums });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// BLOCK 24: API ROUTES - VOTES
app.get('/api/votes/top/:limit', async (req, res) => {
  try {
    const limit = parseInt(req.params.limit) || 10;
    const topVoters = await Vote.find().sort({ totalVotes: -1 }).limit(limit);
    res.json({ success: true, count: topVoters.length, topVoters });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/votes/user/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    const voteRecord = await Vote.findOne({ userId });

    if (!voteRecord) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    res.json({
      success: true,
      userId: voteRecord.userId,
      username: voteRecord.username,
      totalVotes: voteRecord.totalVotes,
      lastVoteAt: voteRecord.lastVoteAt,
      voteHistory: voteRecord.votedAt
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// BLOCK 25: TOP.GG WEBHOOK
app.post('/topgg/webhook', async (req, res) => {
  const auth = req.headers.authorization;

  if (!auth || auth !== process.env.TOPGG_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { user, isWeekend } = req.body;

    let voteRecord = await Vote.findOne({ userId: user });

    if (!voteRecord) {
      voteRecord = new Vote({
        userId: user,
        totalVotes: 1,
        lastVoteAt: new Date(),
        votedAt: [new Date()]
      });
    } else {
      voteRecord.totalVotes += 1;
      voteRecord.lastVoteAt = new Date();
      voteRecord.votedAt.push(new Date());
    }

    await voteRecord.save();

    console.log(`✅ Vote recorded for user ${user}`);

    res.json({ success: true });
  } catch (error) {
    console.error('❌ Webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

// BLOCK 26: ERROR HANDLING MIDDLEWARE
app.use((err, req, res, next) => {
  console.error('❌ Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// BLOCK 27: START SERVER
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🌐 Web server running on port ${PORT}`);
});

// BLOCK 28: BOT LOGIN
client.login(process.env.DISCORD_TOKEN);

module.exports = { client, PREFIX };
