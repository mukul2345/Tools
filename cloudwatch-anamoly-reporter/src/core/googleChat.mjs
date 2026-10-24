#!/usr/bin/env node
/**
 * Google Chat - Send messages to Google Chat webhook
 */

import { getGoogleChatWebhook } from "./configLoader.mjs";

/**
 * Send message to Google Chat
 * @param {string} message - Message text
 * @param {string} signedUrl - Optional AWS Console S3 URL (requires AWS Console login to access)
 * @returns {Promise<void>}
 */
export async function postToGoogleChat(message, signedUrl = null) {
  const webhookUrl = await getGoogleChatWebhook();

  if (!webhookUrl) {
    console.warn("Google Chat webhook not configured, skipping notification");
    return;
  }

  // Enhance message with clickable link if signedUrl is provided
  // Google Chat auto-links URLs in text, so we include the URL directly
  let enhancedMessage = message;
  if (signedUrl) {
    // Format message with proper spacing and link
    enhancedMessage = `${message}\n\n📄 View HTML Report:\n${signedUrl}`;
  } else {
    // Ensure message has proper formatting even without URL
    enhancedMessage = message;
  }

  const card = {
    cards: [
      {
        header: {
          title: "CloudWatch Anomaly Report",
          subtitle: new Date().toLocaleString(),
        },
        sections: [
          {
            widgets: [
              {
                textParagraph: {
                  text: enhancedMessage,
                },
              },
            ],
          },
          ...(signedUrl
            ? [
                {
                  widgets: [
                    {
                      buttons: [
                        {
                          textButton: {
                            text: "📄 View HTML Report",
                            onClick: {
                              openLink: {
                                url: signedUrl,
                              },
                            },
                          },
                        },
                      ],
                    },
                  ],
                },
              ]
            : []),
        ],
      },
    ],
  };

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(card),
    });

    if (!response.ok) {
      throw new Error(`Google Chat API error: ${response.status} ${response.statusText}`);
    }
  } catch (error) {
    console.error(`Failed to post to Google Chat: ${error.message}`);
    throw error;
  }
}

