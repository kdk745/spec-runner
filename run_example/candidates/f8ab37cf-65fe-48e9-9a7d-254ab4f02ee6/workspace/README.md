# Patient Intake Form

A frontend-only, single-page patient intake form with automatic localStorage persistence.

## Features

- ✅ Pure frontend implementation (no server required)
- ✅ Automatic form data persistence to browser localStorage
- ✅ Form data restoration on page reload
- ✅ Auto-save as user types
- ✅ Form validation for required fields
- ✅ Clean, responsive design
- ✅ Runs directly from file:// protocol (no build step needed)

## How to Run

Simply open `index.html` directly in your web browser:

```bash
open index.html
```

Or double-click the `index.html` file in your file explorer.

## Form Sections

1. **Personal Information** - Name, DOB, gender
2. **Contact Information** - Email, phone, address
3. **Medical History** - Chronic conditions, medications, allergies
4. **Insurance Information** - Provider, policy number, group number
5. **Emergency Contact** - Contact name, phone, relationship
6. **Consent & Agreement** - Medical and privacy consent checkboxes

## Data Persistence

- All form data is automatically saved to browser localStorage as you type
- Data is restored automatically when the page is reloaded
- An info message confirms data restoration on page load
- Clear button removes all saved data after confirmation
- Submit button validates and persists the form

## Browser Compatibility

Works on all modern browsers with localStorage support:
- Chrome/Edge (v20+)
- Firefox (v4+)
- Safari (v4+)
- Opera (v11+)

## File Structure

```
index.html          - Complete single-file application
README.md          - This file
```

No dependencies, no build process, no server required. Pure vanilla HTML, CSS, and JavaScript.
