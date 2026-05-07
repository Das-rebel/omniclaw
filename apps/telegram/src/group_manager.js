/**
 * Group Manager - Group-specific features for Telegram
 *
 * Provides:
 * - Group member tracking
 * - Mention detection and handling
 * - Admin commands (ban, mute, pin)
 * - Group settings management
 */

const logger = require('./logger');

class GroupManager {
  constructor(options = {}) {
    this.sessionManager = options.sessionManager;
    this.bot = options.bot; // Telegram bot instance for sending messages
    this.adminCommands = new Map(); // chatId -> Map<userId, commandCount>

    // Group settings cache
    this.groupSettings = new Map(); // chatId -> settings

    // Default settings
    this.defaultSettings = {
      mentionEnabled: true,
      welcomeMessage: true,
      goodbyeMessage: false,
      botMentionRequired: false, // Require @botname for commands
      maxMentionsPerMinute: 5
    };
  }

  /**
   * Track group members
   */
  async trackGroupMembers(chatId, members) {
    const session = this.sessionManager?.getOrCreate(chatId, { chatType: 'supergroup' });
    if (session) {
      session.groupMembers = new Map(members.map(m => [m.user.id, {
        id: m.user.id,
        username: m.user.username,
        firstName: m.user.first_name,
        lastName: m.user.last_name,
        isAdmin: m.status === 'administrator',
        isOwner: m.status === 'creator'
      }]));
    }
    logger.info(`Tracked ${members.length} members in chat ${chatId}`);
  }

  /**
   * Handle group mention
   */
  async handleGroupMention(message) {
    const chatId = message.chat.id;
    const text = message.text || '';
    const mentionPattern = /@[\w]+/g;
    const mentions = text.match(mentionPattern) || [];

    // Check if any mention is our bot
    const botUsername = await this.getBotUsername();
    const botMentioned = mentions.some(m =>
      m.toLowerCase() === `@${botUsername}`.toLowerCase()
    );

    // Get sender info
    const from = message.from;
    const sender = {
      id: from.id,
      username: from.username,
      firstName: from.first_name,
      isAdmin: this.isAdmin(chatId, from.id)
    };

    logger.info(`Group mention detected: ${mentions.join(', ')} by ${sender.username}`);

    // Update mention tracking
    this.trackMention(chatId, from.id);

    // Check rate limits
    if (this.isRateLimited(chatId, from.id)) {
      return {
        text: `⚠️ @${sender.username}, you're sending too many mentions. Please slow down.`,
        parse_mode: 'Markdown'
      };
    }

    return {
      botMentioned,
      sender,
      mentions,
      chatId
    };
  }

  /**
   * Get bot username
   */
  async getBotUsername() {
    try {
      if (this.bot && this.bot.getMe) {
        const me = await this.bot.getMe();
        return me.username;
      }
    } catch (error) {
      logger.warn('Could not get bot username:', error.message);
    }
    return process.env.TELEGRAM_BOT_NAME || 'OmniClawBot';
  }

  /**
   * Track mention for rate limiting
   */
  trackMention(chatId, userId) {
    const key = `${chatId}:${userId}`;
    const now = Date.now();

    if (!this.adminCommands.has(key)) {
      this.adminCommands.set(key, { count: 0, resetAt: now + 60000 });
    }

    const track = this.adminCommands.get(key);

    if (now > track.resetAt) {
      track.count = 1;
      track.resetAt = now + 60000;
    } else {
      track.count++;
    }
  }

  /**
   * Check if user is rate limited
   */
  isRateLimited(chatId, userId) {
    const settings = this.getGroupSettings(chatId);
    const key = `${chatId}:${userId}`;
    const track = this.adminCommands.get(key);

    if (!track) return false;

    return track.count > (settings.maxMentionsPerMinute || 5);
  }

  /**
   * Handle admin command
   */
  async handleAdminCommand(command, args, message) {
    const chatId = message.chat.id;
    const from = message.from;

    // Check if user is admin
    if (!this.isAdmin(chatId, from.id)) {
      return {
        text: `⚠️ This command is only available to group admins.`,
        parse_mode: 'Markdown'
      };
    }

    const targetUsername = args?.match(/@(\w+)/)?.[1];
    const targetUser = targetUsername
      ? await this.findUserByUsername(chatId, targetUsername)
      : this.getReplyToUser(message);

    if (!targetUser && !targetUsername) {
      return {
        text: `Usage: \`/${command} @username\` or reply to a user's message`,
        parse_mode: 'Markdown'
      };
    }

    try {
      switch (command) {
        case 'ban':
          return await this.banUser(chatId, targetUser, from);

        case 'mute':
          return await this.muteUser(chatId, targetUser, from);

        case 'pin':
          return this.pinMessage(message);

        case 'unmute':
          return await this.unmuteUser(chatId, targetUser, from);

        case 'warn':
          return await this.warnUser(chatId, targetUser, args, from);

        default:
          return { text: `Unknown admin command: /${command}` };
      }
    } catch (error) {
      logger.error(`Admin command ${command} failed:`, error);
      return {
        text: `Command failed: ${error.message}`,
        parse_mode: 'Markdown'
      };
    }
  }

  /**
   * Ban user from group
   */
  async banUser(chatId, targetUser, admin) {
    if (!targetUser) {
      return { text: 'User not found. Please specify a valid @username or reply to their message.' };
    }

    try {
      if (this.bot && this.bot.kickChatMember) {
        await this.bot.kickChatMember(chatId, targetUser.id);
      }

      logger.info(`User ${targetUser.username} banned by ${admin.username} in ${chatId}`);

      return {
        text: `✅ *@${targetUser.username}* has been banned from the group.\n\nBanned by @${admin.username}`,
        parse_mode: 'Markdown'
      };
    } catch (error) {
      return {
        text: `Failed to ban user: ${error.message}`,
        parse_mode: 'Markdown'
      };
    }
  }

  /**
   * Mute user in group
   */
  async muteUser(chatId, targetUser, admin) {
    if (!targetUser) {
      return { text: 'User not found.' };
    }

    try {
      if (this.bot && this.bot.restrictChatMember) {
        await this.bot.restrictChatMember(chatId, targetUser.id, {
          can_send_messages: false,
          can_send_media_messages: false,
          can_send_other_messages: false
        });
      }

      logger.info(`User ${targetUser.username} muted by ${admin.username} in ${chatId}`);

      return {
        text: `🔇 *@${targetUser.username}* has been muted.\n\nMuted by @${admin.username}`,
        parse_mode: 'Markdown'
      };
    } catch (error) {
      return {
        text: `Failed to mute user: ${error.message}`,
        parse_mode: 'Markdown'
      };
    }
  }

  /**
   * Unmute user
   */
  async unmuteUser(chatId, targetUser, admin) {
    if (!targetUser) {
      return { text: 'User not found.' };
    }

    try {
      if (this.bot && this.bot.restrictChatMember) {
        await this.bot.restrictChatMember(chatId, targetUser.id, {
          can_send_messages: true,
          can_send_media_messages: true,
          can_send_other_messages: true
        });
      }

      return {
        text: `🔊 *@${targetUser.username}* has been unmuted.\n\nUnmuted by @${admin.username}`,
        parse_mode: 'Markdown'
      };
    } catch (error) {
      return {
        text: `Failed to unmute user: ${error.message}`,
        parse_mode: 'Markdown'
      };
    }
  }

  /**
   * Pin message
   */
  pinMessage(message) {
    const chatId = message.chat.id;
    const messageId = message.reply_to_message?.message_id || message.message_id;

    if (this.bot && this.bot.pinChatMessage) {
      this.bot.pinChatMessage(chatId, messageId, { disable_notification: false })
        .catch(err => logger.error('Failed to pin message:', err));
    }

    return {
      text: `📌 Message pinned!\n\nPinned by @${message.from.username}`,
      parse_mode: 'Markdown'
    };
  }

  /**
   * Warn user
   */
  async warnUser(chatId, targetUser, reason, admin) {
    if (!targetUser) {
      return { text: 'User not found.' };
    }

    // Store warning (simplified - use database in production)
    const warnKey = `${chatId}:${targetUser.id}`;
    const warns = (await this.getUserWarns(chatId, targetUser.id)) || [];
    warns.push({
      reason: reason || 'No reason provided',
      by: admin.username,
      at: Date.now()
    });

    this.storeUserWarns(warnKey, warns);

    const warningCount = warns.length;
    const maxWarns = 3;

    let response = `⚠️ *@${targetUser.username}* has been warned (${warningCount}/${maxWarns})`;

    if (reason) {
      response += `\nReason: ${reason}`;
    }

    response += `\n\nWarned by @${admin.username}`;

    // Auto-mute after 3 warns
    if (warningCount >= maxWarns) {
      response += `\n\n🔇 User has reached maximum warnings and has been muted.`;
      await this.muteUser(chatId, targetUser, { username: 'system' });
    }

    return { text: response, parse_mode: 'Markdown' };
  }

  /**
   * Get user warns (simplified storage)
   */
  async getUserWarns(chatId, userId) {
    const key = `warns:${chatId}:${userId}`;
    // In production, use Redis or database
    return [];
  }

  /**
   * Store user warns
   */
  storeUserWarns(key, warns) {
    // In production, use Redis or database
  }

  /**
   * Find user by username in chat
   */
  async findUserByUsername(chatId, username) {
    const session = this.sessionManager?.get(chatId);
    if (session && session.groupMembers) {
      for (const member of session.groupMembers.values()) {
        if (member.username?.toLowerCase() === username.toLowerCase()) {
          return member;
        }
      }
    }
    return null;
  }

  /**
   * Get user from reply-to message
   */
  getReplyToUser(message) {
    if (message.reply_to_message) {
      const reply = message.reply_to_message.from;
      return {
        id: reply.id,
        username: reply.username,
        firstName: reply.first_name
      };
    }
    return null;
  }

  /**
   * Check if user is admin
   */
  isAdmin(chatId, userId) {
    const session = this.sessionManager?.get(chatId);
    if (session && session.adminIds) {
      return session.adminIds.has(userId);
    }
    return false;
  }

  /**
   * Get group settings
   */
  getGroupSettings(chatId) {
    if (!this.groupSettings.has(chatId)) {
      this.groupSettings.set(chatId, { ...this.defaultSettings });
    }
    return this.groupSettings.get(chatId);
  }

  /**
   * Update group settings
   */
  updateGroupSettings(chatId, settings) {
    const current = this.getGroupSettings(chatId);
    this.groupSettings.set(chatId, { ...current, ...settings });
    return this.getGroupSettings(chatId);
  }

  /**
   * Handle group settings command
   */
  async handleGroupSettings(chatId) {
    const settings = this.getGroupSettings(chatId);

    const settingsText = `*Group Settings* ⚙️

Current configuration:

👤 *Mention Settings*
• Mention required: ${settings.botMentionRequired ? 'Yes' : 'No'}
• Max mentions/min: ${settings.maxMentionsPerMinute}

💬 *Message Settings*
• Welcome messages: ${settings.welcomeMessage ? 'On' : 'Off'}
• Goodbye messages: ${settings.goodbyeMessage ? 'On' : 'Off'}

*Admin Commands:*
• /ban @username - Ban user
• /mute @username - Mute user
• /unmute @username - Unmute user
• /warn @username [reason] - Warn user
• /pin - Pin message`;

    return {
      text: settingsText,
      parse_mode: 'Markdown'
    };
  }

  /**
   * Handle new chat member (welcome)
   */
  async handleNewMembers(chatId, newMembers) {
    const settings = this.getGroupSettings(chatId);

    if (!settings.welcomeMessage) return null;

    const names = newMembers.map(m => m.first_name).join(', ');

    return {
      text: `Welcome *${names}* to the group! 👋\n\nFeel free to introduce yourself.`,
      parse_mode: 'Markdown'
    };
  }

  /**
   * Handle left chat member (goodbye)
   */
  async handleLeftMember(chatId, leftMember) {
    const settings = this.getGroupSettings(chatId);

    if (!settings.goodbyeMessage) return null;

    return {
      text: `@${leftMember.username || leftMember.first_name} has left the group. 👋`,
      parse_mode: 'Markdown'
    };
  }
}

module.exports = { GroupManager };