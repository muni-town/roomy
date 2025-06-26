import { format } from "date-fns";
import { Space } from "@roomy-chat/sdk";
import { co } from "jazz-tools";

export interface UserActivity {
  activityByDate: Record<string, number>;
  activityBySpace: Record<string, { name: string; count: number }>;
}

class ActivityIndex {
  async getUserActivity(userId: string, joinedSpaces: co.loaded<typeof Space>[]): Promise<UserActivity> {
    const activityByDate: Record<string, number> = {};
    const activityBySpace: Record<string, { name: string; count: number }> = {};


    for (const space of joinedSpaces) {
      if (!space || !space.channels) continue;

      let spaceMessageCount = 0;
      
      // Get all chat channels in this space (exclude feeds channels)
      const channels = space.channels.filter(channel => 
        channel && 
        !channel.softDeleted && 
        channel.channelType !== "feeds"
      );
      
      
      for (const channel of channels) {
        if (!channel || !channel.mainThread?.timeline) continue;

        try {
          // Get all messages from the channel's main thread using the timeline structure
          const timeline = channel.mainThread.timeline;
          if (!timeline) continue;

          // Debug timeline structure
          const accountIds = timeline.perAccount ? Object.keys(timeline.perAccount) : [];
          const accountDetails = accountIds.map(accountId => {
            const feed = timeline.perAccount?.[accountId];
            return {
              accountId,
              hasAll: !!feed?.all,
              messageCount: feed?.all?.size || 0,
              allType: feed?.all?.constructor?.name || 'unknown'
            };
          });
          
          const totalMessages = accountDetails.reduce((total, account) => total + account.messageCount, 0);
          

          // Get the user's specific timeline feed
          const userAccountFeed = timeline.perAccount?.[userId];
          if (!userAccountFeed?.all) {
            continue;
          }

          // Process all messages from this user
          const userMessages = Array.from(userAccountFeed.all);
          
          for (const messageRef of userMessages) {
            try {
              // Try to get the message object
              const message = typeof messageRef === 'string' ? null : messageRef;
              
              if (message && message.madeAt) {
                const dateStr = format(message.madeAt, "yyyy-MM-dd");
                activityByDate[dateStr] = (activityByDate[dateStr] || 0) + 1;
                spaceMessageCount++;
              }
            } catch (error) {
              console.debug("Could not process message:", messageRef, error);
            }
          }
        } catch (error) {
          console.debug("Error processing channel:", channel.id, error);
        }
      }

      // Add space to activity summary
      if (spaceMessageCount > 0) {
        activityBySpace[space.id] = {
          name: space.name || "Unnamed Space",
          count: spaceMessageCount
        };
      }
    }

    return {
      activityByDate,
      activityBySpace
    };
  }

  async getSpaceActivity(userId: string, space: co.loaded<typeof Space>): Promise<Record<string, number>> {
    const activityByDate: Record<string, number> = {};

    if (!space || !space.channels) return activityByDate;

    // Get all chat channels in this space (exclude feeds channels)
    const channels = space.channels.filter(channel => 
      channel && 
      !channel.softDeleted && 
      channel.channelType !== "feeds"
    );
    
    for (const channel of channels) {
      if (!channel || !channel.mainThread?.timeline) continue;

      try {
        // Get all messages from the channel's main thread using the timeline structure
        const timeline = channel.mainThread.timeline;
        if (!timeline) continue;

        // Get the user's specific timeline feed
        const userAccountFeed = timeline.perAccount?.[userId];
        if (!userAccountFeed?.all) continue;

        // Process all messages from this user
        const userMessages = Array.from(userAccountFeed.all);
        
        for (const messageRef of userMessages) {
          try {
            // Try to get the message object
            const message = typeof messageRef === 'string' ? null : messageRef;
            
            if (message && message.madeAt) {
              const dateStr = format(message.madeAt, "yyyy-MM-dd");
              activityByDate[dateStr] = (activityByDate[dateStr] || 0) + 1;
            }
          } catch (error) {
            console.debug("Could not process message:", messageRef, error);
          }
        }
      } catch (error) {
        console.debug("Error processing channel:", channel.id, error);
      }
    }

    return activityByDate;
  }
}

export const activityIndex = new ActivityIndex();