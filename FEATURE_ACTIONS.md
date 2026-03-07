# Actions Feature for SSH Thing

## Overview

The Actions feature for SSH Thing allows users to define and execute one-shot commands on remote servers with a single click. This simplifies repetitive tasks by automating the entire workflow: connecting to a server, running a specific command, and exiting the session once the command completes.

## User Requirements

1. **Action Definition**: Users should be able to create, edit, and delete actions
2. **One-Click Execution**: Each action should be executable with a single click from the UI
3. **Server Selection**: Each action should be associated with a specific server (or allow selecting a server dynamically)
4. **Command Configuration**: Each action should specify a command (or series of commands) to execute on the remote server
5. **Automation**: The action should automatically connect to the server, run the command, and disconnect once the command completes
6. **Feedback**: Users should see feedback about the action's progress (connecting, running, completed, error)
7. **History**: Keep a history of executed actions with timestamps and results

## Implementation Plan

### 1. Backend Changes (Rust / src-tauri/src/lib.rs)

#### New Data Structure: Action

Add a new `Action` struct to represent an action in the backend:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Action {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub server_id: String, // ID of the server to connect to
    pub command: String, // Command to execute on the remote server
    pub timeout_seconds: Option<u64>, // Optional timeout for the command execution
    #[serde(default)]
    pub last_executed_at: Option<u64>, // Timestamp of last execution
    #[serde(default)]
    pub last_execution_status: Option<String>, // Status of last execution (success/error)
}
```

#### Storage Management

- Create new functions to load and save actions:
  - `get_actions()`: Load actions from a `actions.json` file
  - `add_action()`: Add a new action to the storage
  - `update_action()`: Update an existing action
  - `delete_action()`: Delete an action from storage
- Store actions in a new `actions.json` file in the application data directory

#### New Tauri Commands

Add new Tauri commands to manage actions and execute them:

```rust
#[tauri::command]
async fn get_actions(app: AppHandle) -> Result<Vec<Action>, String> {
    // Load actions from storage
}

#[tauri::command]
async fn add_action(app: AppHandle, action: Action) -> Result<Vec<Action>, String> {
    // Save new action
}

#[tauri::command]
async fn update_action(app: AppHandle, id: String, action: Action) -> Result<Vec<Action>, String> {
    // Update existing action
}

#[tauri::command]
async fn delete_action(app: AppHandle, id: String) -> Result<Vec<Action>, String> {
    // Delete action from storage
}

#[tauri::command]
async fn execute_action(app: AppHandle, action_id: String) -> Result<(), String> {
    // Execute the action: connect to server, run command, disconnect
}
```

#### Execution Logic

Implement a function to execute an action:

1. Load the action from storage
2. Retrieve the associated server details
3. Establish a connection to the server
4. Run the specified command
5. Capture the command output
6. Disconnect once the command completes
7. Update the action's last executed time and status

### 2. Frontend Changes (HTML / CSS / JavaScript)

#### UI Components

##### Sidebar Tab

Add a new "Actions" tab to the sidebar:

```html
<!-- Tab Button in Sidebar -->
<button id="tab-actions" class="tab-btn flex-1 text-sm font-medium">
  Actions
</button>

<!-- Tab Content: Actions -->
<div id="view-actions" class="flex-1 flex flex-col min-h-0 hidden">
  <div class="sidebar-section-header flex justify-between items-center border-b border-gray-200/60 dark:border-gray-700/50">
    <span class="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">Actions</span>
    <button id="add-action-btn" class="ghost-btn ghost-btn-primary">
      <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>
      Add
    </button>
  </div>
  <div class="sidebar-list flex-1 overflow-y-auto space-y-2" id="action-list">
    <!-- Action items will be injected here -->
  </div>
</div>
```

##### Action Item Component

Create a component to display individual actions in the sidebar:

```html
<div class="action-item p-3 rounded-lg bg-gray-50 dark:bg-gray-800/50 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800 border border-gray-200 dark:border-gray-700/50 transition-colors">
  <div class="flex justify-between items-start">
    <div class="flex-1 min-w-0">
      <h3 class="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">Action Name</h3>
      <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5 truncate">Execute command on server</p>
    </div>
    <button class="action-execute-btn ml-2 p-1 text-blue-500 hover:text-blue-600">
      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
    </button>
  </div>
  <div class="flex items-center mt-2 text-xs text-gray-400 dark:text-gray-500">
    <span>Last executed: 2 days ago</span>
  </div>
</div>
```

##### Action Editor Modal

Add a modal to create and edit actions:

```html
<div id="action-modal" class="hidden fixed inset-0 modal-backdrop z-50">
  <div class="modal-content modal-panel dialog-card w-96 max-w-sm mx-4">
    <div class="flex items-center gap-3 mb-4">
      <h3 id="action-modal-title" class="text-lg font-bold">Create Action</h3>
    </div>
    <div class="form">
      <div class="mb-4">
        <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Name</label>
        <input id="action-name" type="text" placeholder="Action name" class="form-input w-full text-sm" />
      </div>
      <div class="mb-4">
        <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Description</label>
        <input id="action-description" type="text" placeholder="Optional description" class="form-input w-full text-sm" />
      </div>
      <div class="mb-4">
        <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Server</label>
        <select id="action-server" class="form-select w-full text-sm">
          <!-- Options will be populated from saved servers -->
        </select>
      </div>
      <div class="mb-4">
        <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Command</label>
        <textarea id="action-command" placeholder="Command to execute" class="form-textarea w-full text-sm h-24"></textarea>
      </div>
      <div class="flex justify-end gap-2">
        <button id="action-modal-cancel" class="ghost-btn">Cancel</button>
        <button id="action-modal-save" class="ghost-btn ghost-btn-primary">Save</button>
      </div>
    </div>
  </div>
</div>
```

#### JavaScript Functions

Add functions to manage and execute actions:

```javascript
// Load actions from backend
async function loadActions() {
  try {
    const actions = await invoke('get_actions');
    renderActions(actions);
  } catch (error) {
    console.error('Failed to load actions:', error);
  }
}

// Render actions in sidebar
function renderActions(actions) {
  const actionList = document.getElementById('action-list');
  actionList.innerHTML = '';

  actions.forEach(action => {
    const actionItem = createActionItem(action);
    actionList.appendChild(actionItem);
  });
}

// Create action item element
function createActionItem(action) {
  const div = document.createElement('div');
  div.className = 'action-item p-3 rounded-lg bg-gray-50 dark:bg-gray-800/50 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800 border border-gray-200 dark:border-gray-700/50 transition-colors';

  const lastExecuted = action.last_executed_at
    ? new Date(action.last_executed_at * 1000).toLocaleDateString()
    : 'Never executed';

  div.innerHTML = `
    <div class="flex justify-between items-start">
      <div class="flex-1 min-w-0">
        <h3 class="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">${action.name}</h3>
        <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5 truncate">${action.description || 'No description'}</p>
      </div>
      <button class="action-execute-btn ml-2 p-1 text-blue-500 hover:text-blue-600">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
      </button>
    </div>
    <div class="flex items-center mt-2 text-xs text-gray-400 dark:text-gray-500">
      <span>Last executed: ${lastExecuted}</span>
    </div>
  `;

  const executeBtn = div.querySelector('.action-execute-btn');
  executeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    executeAction(action.id);
  });

  return div;
}

// Execute an action
async function executeAction(actionId) {
  try {
    await invoke('execute_action', { actionId });
    showToast('Action executed successfully', 'success');
    loadActions(); // Refresh to update last executed time
  } catch (error) {
    showToast('Failed to execute action: ' + error, 'error');
  }
}

// Open action editor modal
function openActionModal(action = null) {
  const modal = document.getElementById('action-modal');
  const title = document.getElementById('action-modal-title');
  const nameInput = document.getElementById('action-name');
  const descriptionInput = document.getElementById('action-description');
  const serverSelect = document.getElementById('action-server');
  const commandInput = document.getElementById('action-command');

  if (action) {
    title.textContent = 'Edit Action';
    nameInput.value = action.name;
    descriptionInput.value = action.description || '';
    serverSelect.value = action.server_id;
    commandInput.value = action.command;
  } else {
    title.textContent = 'Create Action';
    nameInput.value = '';
    descriptionInput.value = '';
    serverSelect.value = '';
    commandInput.value = '';
  }

  modal.classList.remove('hidden');
}
```

### 3. Integration Points

1. **Sidebar Navigation**: Add a new tab button and tab content view for actions
2. **Modal Management**: Add a new modal for creating and editing actions
3. **Server Selection**: Populate the server dropdown with saved servers
4. **Execution Flow**: Implement the action execution logic in the backend
5. **Status Updates**: Provide feedback to users during execution
6. **Error Handling**: Handle errors during execution and show appropriate messages

### 4. Polishing Features

1. **Action Status Indicators**: Show visual indicators of action status during execution
2. **Command Output**: Display the command output in the terminal or a dedicated modal
3. **Success/Failure Feedback**: Show toast messages indicating the result of the action
4. **Keyboard Shortcuts**: Allow executing actions with keyboard shortcuts
5. **Action Groups**: Allow organizing actions into groups or categories
6. **Import/Export**: Allow importing and exporting actions for backup and sharing
7. **Execution History**: Keep a detailed log of executed actions with timestamps and results

### 5. UI/UX Considerations

1. **Visual Hierarchy**: Make actions distinct from servers and snippets
2. **Action Button**: Use a play icon to indicate execution
3. **Feedback**: Show progress indicators and results
4. **Error Handling**: Display clear error messages for failed actions
5. **Responsive Design**: Ensure the actions UI is responsive on different screen sizes

## Files to Modify

1. `src-tauri/src/lib.rs`: Add action struct, storage functions, and commands
2. `frontend/index.html`: Add sidebar tab, tab content, and modal
3. `frontend/main.js`: Add JavaScript functions for managing and executing actions
4. `frontend/index.html (styles)`: Add CSS styles for action-related components

## Testing Strategy

1. Test creating, editing, and deleting actions
2. Test executing actions on different servers
3. Test error handling for failed connections and commands
4. Test the UI responsiveness
5. Test the integration with existing features (servers, snippets, terminals)

## Future Enhancements

1. **Action Templates**: Provide pre-built action templates for common tasks
2. **Action Scheduling**: Allow scheduling actions to run at specific times
3. **Parallel Execution**: Allow executing multiple actions in parallel
4. **Variable Support**: Allow using variables in commands (e.g., `{{USER}}`, `{{HOST}}`)
5. **Conditional Logic**: Allow adding conditional logic to actions
6. **Action Chains**: Allow creating chains of actions that execute in sequence
