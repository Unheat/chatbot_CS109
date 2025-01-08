import { Hono } from 'hono'
import mammoth from 'mammoth'; // Import mammoth for .docx file text extraction

// Define TypeScript interfaces for Cloudflare environment bindings and material structure
interface CloudflareBindings {
  AI: any;  // Binding for Cloudflare's AI service
  DB: D1Database;  // Binding for Cloudflare's D1 SQLite database
}

interface Material { 
  title: string;
  content: string;
}

// Initialize Hono app with Cloudflare bindings
const app = new Hono<{ Bindings: CloudflareBindings }>()

// Root route: Serves a single-page web application with chat interface
app.get('/', (c) => {
  // HTML with embedded CSS and JavaScript for interactive chat experience
  // Features include:
  // - Dark mode styling
  // - Message history tracking
  // - Dynamic message rendering
  // - Material initialization on page load
  // - Client-side message sending and receiving
  return c.html(`
    <!DOCTYPE html>
    <html>
      <head>
        <style>
          body {
            display: flex;
            flex-direction: column;
            justify-content: center;
            align-items: center;
            height: 100vh;
            margin: 0;
            background-color: #1a1a1a;  /* Dark background */
            color: #ffffff;  /* White text */
          }

          h1 {
            font-size: 3em;
            color: #ffffff;  /* White text */
          }

          #messageBox {
            width: 80%;
            max-width: 800px;
            min-height: 200px;
            border: 1px solid #333;  /* Darker border */
            padding: 20px;
            margin: 20px 0;
            white-space: pre-wrap;
            overflow-y: auto;
            max-height: 400px;
            background-color: #2d2d2d;  /* Slightly lighter than body */
            color: #ffffff;
          }

          input[type="text"] {
            padding: 15px;
            width: 400px;
            margin: 15px 0;
            font-size: 1.2em;
            background-color: #333;  /* Dark input background */
            color: #ffffff;  /* White text */
            border: 1px solid #444;
            border-radius: 5px;
          }

          input[type="text"]::placeholder {
            color: #aaaaaa;  /* Lighter placeholder text */
          }

          button {
            padding: 15px 25px;
            background-color: #4CAF50;
            color: white;
            border: none;
            cursor: pointer;
            font-size: 1.2em;
            border-radius: 5px;
          }

          button:hover {
            background-color: #45a049;
          }

          .message {
            margin: 10px 0;
            padding: 10px;
            border-radius: 5px;
          }

          .user-message {
            background-color: #2c5282;  /* Dark blue */
            text-align: right;
            color: #ffffff;
          }

          .ai-message {
            background-color: #383838;  /* Dark gray */
            text-align: left;
            color: #ffffff;
          }
        </style>
      </head>
      <body>
        <h1>Hello CS-109!</h1>
        <div id="messageBox"></div>
        <input type="text" id="messageInput" placeholder="Type your message here..." onkeydown="checkEnter(event)">
        <button onclick="sendMessage()">Send</button>

        
        <script> 
          let messageHistory = [];      // this line is to store chat history
          let courseMaterials = null;  // Store all database materials here
          let usedMaterials = [];      // this line is to track used materials

          // Fetch materials when page loads
          async function initializeMaterials() {
            try {
              const response = await fetch('/init-materials');
              const data = await response.json();
              courseMaterials = data.materials;
              console.log('Initial materials loaded:', {
                count: data.materials?.length || 0,
                materials: data.materials
              });
            } catch (error) {
              console.error('Error loading materials:', error);
            }
          }

          // Call initialization when page loads
          initializeMaterials();

          function addMessageToBox(content, isUser) {
            const messageBox = document.getElementById('messageBox');
            const messageDiv = document.createElement('div');
            messageDiv.className = \`message \${isUser ? 'user-message' : 'ai-message'}\`;
            messageDiv.textContent = content;
            messageBox.appendChild(messageDiv);
            messageBox.scrollTop = messageBox.scrollHeight;
          }

          async function sendMessage() {
            const input = document.getElementById('messageInput');
            const message = input.value.trim();
            
            if (!message) return;
            
            // Clear input immediately
            input.value = '';
            addMessageToBox(message, true);
            
            try {
              const response = await fetch('/chat', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ 
                  message,
                  history: messageHistory, 
                  materials: courseMaterials, // store all data from DB, this helps not to retrive DB only once.
                  usedMaterials: usedMaterials  // Add this line to send used materials
                })
              });
              
              const data = await response.json();
              addMessageToBox(data.response, false);
              
              usedMaterials = data.usedMaterials;  // Add this line to store updated materials
              
              messageHistory.push(
                { role: 'user', content: message },
                { role: 'assistant', content: data.response }
              );
            } catch (error) {
              console.error('Error:', error);
              addMessageToBox('Error sending message', false);
            }
          }

          function checkEnter(event) {
            if (event.key === 'Enter') {
              event.preventDefault();
              sendMessage();
            }
          }
        </script>
      </body>
    </html>
  `);
})

// Server-side: This function gets ALL materials from DB
async function retrieveAllMaterials(db: D1Database) {
  try {
    // Execute SQL query to select all materials
    const results = await db.prepare('SELECT * FROM materials').all();
    
    // Error handling for database query
    if (!results?.results) {
      console.error('No valid results returned from database');
      return [];
    }
    return results.results;
  } catch (error) {
    console.error('Database error:', error);
    return [];
  }
}

// Endpoint to initialize materials when the page loads
app.get('/init-materials', async (c) => {
  try {
    // Fetch all materials from the database
    const materials = await retrieveAllMaterials(c.env.DB);
    return c.json({ materials });
  } catch (error) {
    // Error handling with detailed response
    console.error('Error:', error);
    return c.json({ 
      error: 'Failed to fetch materials', 
      details: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// Chat endpoint for processing user messages
app.post('/chat', async (c) => {
  /**
   * Chatbot Processing Flow:
   * 1. Initial Title Selection:
   *    - Initially sends all the titles in DB, current message of user, and chat history to AI
   *    - AI selects relevant titles based on user's question( with given context)
   * 
   * 2. Content Retrieval:
   *    - Extracts selected titles from AI's response
   *    - Fetches full content only for new materials based on selected titles
   *    - Maintains previously used materials for context
   * 
   * 3. Final Response Generation:
   *    - Combines selected materials with conversation history
   *    - Sends full context to AI for final response
   *    - Returns AI's response with updated material context
   * 
   * Note: For general conversation (greetings, etc.), 
   * the AI will not select any materials and respond naturally.
   */
  try {
    let { message, history, materials, usedMaterials = [] } = await c.req.json();
    // Step 1: Send only the titles to the AI
    const titles = (materials as Material[]).map(m => m.title).join('\n');

    const initialPrompt = `You are an title selector. Here are the available material titles:
    ${titles}
    
    Based on the user's question with the context, select the relevant titles(you can select multiple) and respond with them in the format: "selected titles: [Title1, Title2, ...]". For example, "selected titles: lab 3 overview".
    Important:
    - select titles if the user's question is related to the titles
    - For non-course related questions, respond with "selected titles: "`;

    const initialMessages = [
      { role: 'system', content: initialPrompt },  // upper prompt
      { role: 'user', content: message } //user current message
    ];

    // Step 2: Get the AI's response to determine which titles it needs
    const initialResponse = await c.env.AI.run('@cf/meta/llama-2-7b-chat-int8', { 
      messages: initialMessages,
      stream: false
    });
    // Add debug log to see exact AI response
    console.log('AI Initial Response:', initialResponse.response);
    
    // Adjust the regex pattern
    const responseLowerCase = initialResponse.response.toLowerCase();
    const selectedTitlesMatch = responseLowerCase.match(/selected titles:\s*(.+)/);
    console.log('Regex Match Result:', selectedTitlesMatch);

    const selectedTitles = selectedTitlesMatch 
        ? selectedTitlesMatch[1]
            .split(',')
            .map((title: string) => title.trim())
        : [];

    console.log('Extracted Titles:', selectedTitles);

    // Step 3: Fetch the full content only for new titles
    const newMaterials = materials.filter((m: Material) => 
      selectedTitles.some((title: string) => title === m.title) && 
      !usedMaterials.some((used: Material) => used.title === m.title)
    );
    
    // Add debug log to see what materials were found
    console.log('New Materials Found:', newMaterials);

    

    // Directly update usedMaterials if there are new materials
    if (newMaterials.length > 0) {
      usedMaterials.push(...newMaterials);
    }

    // Step 4: Construct a new context with all used materials and their content
    const context = usedMaterials
      .map((material: Material) => 
        `--- ${material.title} ---\n${material.content}\n`
      )
      .join('\n');

    const finalPrompt = `You are an educational assistant. Use the following context to answer the user's question:
    ${context}`;

    const finalMessages = [
      { role: 'system', content: finalPrompt },
      ...(history || []),
      { role: 'user', content: message }
    ];

    // Get the final response from the AI
    const finalResponse = await c.env.AI.run('@cf/meta/llama-2-7b-chat-int8', {
      messages: finalMessages,
      stream: false
    });

    // Return the response along with the updated list of used materials
    return c.json({ 
      response: finalResponse.response,
      usedMaterials: usedMaterials
    });
  } catch (error) {
    console.error('Error:', error);
    return c.json({ 
      error: 'Failed to process request', 
      details: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// Route to serve file upload form
app.get('/upload-form', (c) => {
  return c.html(`
    <form action="/upload" method="POST" enctype="multipart/form-data">
      <input 
        type="text" 
        name="title" 
        placeholder="Document Title"
        required
      >
      <input 
        type="file" 
        name="file" 
        accept=".txt,.doc,.docx,.py"
        required
      >
      <button type="submit">Upload</button>
    </form>
  `)
})

// File upload endpoint
app.post('/upload', async (c) => {
  try {
    // Extract form data: file and title
    const formData = await c.req.formData();
    const file = formData.get('file') as File;
    const title = (formData.get('title') as string).toLowerCase();

    // Validate file and title
    if (!file || !title) {
      return c.json({ error: 'Missing file or title' }, 400);
    }

    let content = '';

    // Handle different file types for text extraction
    if (file.type === 'text/plain' || file.name.endsWith('.py')) {
      // For .txt, .py files, directly read text
      content = await file.text();
    } else if (file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      // For .docx files, use mammoth to extract raw text
      const arrayBuffer = await file.arrayBuffer();
      const uint8Array = new Uint8Array(arrayBuffer);
      const result = await mammoth.extractRawText({ arrayBuffer: uint8Array.buffer });
      content = result.value;
    } 

    // Insert uploaded material into D1 database with lowercase title
    await c.env.DB.prepare(
      'INSERT INTO materials (title, content, type) VALUES (?, ?, ?)'
    )
    .bind(title, content, file.type)
    .run();

    return c.json({ 
      message: 'File uploaded successfully',
      contentPreview: content.substring(0, 100) + '...' // Preview first 100 chars
    });
  } catch (error) {
    // Comprehensive error handling for upload process
    console.error('Upload Error:', error);
    return c.json({ 
      error: 'Failed to upload file', 
      details: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// Export the Hono app as the default export for Cloudflare Workers
export default app

