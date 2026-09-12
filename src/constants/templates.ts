/** Concord-authored starting points. The artwork lives in public/*.svg. */
export const templates = [
  { id: "blank", label: "Blank document", imageUrl: "/blank-document.svg", initialContent: "" },
  {
    id: "software-proposal", label: "Software plan", imageUrl: "/software-proposal.svg",
    initialContent: `
      <h1>Software plan</h1>
      <p>What problem are we solving, and who needs the result?</p>
      <h2>Outcome</h2>
      <p>Describe the experience users will have when this work is complete.</p>
      <h2>Boundaries</h2>
      <p>List the work included, the work deferred, and the assumptions to test.</p>
      <h2>Delivery checkpoints</h2>
      <p>Record owners, review dates, and evidence that each checkpoint is done.</p>
    `,
  },
  {
    id: "project-proposal", label: "Project brief", imageUrl: "/project-proposal.svg",
    initialContent: `
      <h1>Project brief</h1>
      <p>Write the decision this project needs to support.</p>
      <h2>Context and constraints</h2>
      <p>Capture the current state, the people affected, and the limits of the work.</p>
      <h2>Proposed approach</h2>
      <p>Explain the first useful milestone and how the team will learn from it.</p>
      <h2>Open decisions</h2>
      <p>List the questions, owners, and dates needed to move forward.</p>
    `,
  },
  {
    id: "business-letter", label: "Business note", imageUrl: "/business-letter.svg",
    initialContent: `
      <p>[Date]</p><p>To: [Recipient and organization]</p>
      <h1>Re: [Topic]</h1><p>I'm writing about [specific purpose].</p>
      <p>The relevant details are [facts, dates, and next steps].</p>
      <p>Please let me know by [date] if anything needs clarification.</p>
      <p>[Your name and contact details]</p>
    `,
  },
  {
    id: "resume", label: "Profile", imageUrl: "/resume.svg",
    initialContent: `
      <h1>[Your name]</h1><p>[Location] · [Email] · [Portfolio]</p>
      <h2>What I do</h2><p>Summarize the problems you solve and the impact you aim to make.</p>
      <h2>Selected work</h2><p>[Role] · [Team] · [Dates]</p>
      <p>Describe one outcome, your contribution, and a measurable result.</p>
      <h2>Tools and education</h2>
      <p>Include skills and learning that are relevant to this opportunity.</p>
    `,
  },
  {
    id: "cover-letter", label: "Introduction", imageUrl: "/cover-letter.svg",
    initialContent: `
      <p>[Your name] · [Contact details]</p><p>[Date] · [Team or hiring manager]</p>
      <h1>Why this work matters to me</h1>
      <p>Connect one real piece of your experience to the team's challenge.</p>
      <p>Show the work you did, what changed, and what you learned.</p>
      <p>Explain how you would contribute in the first few months.</p>
      <p>Thank you for considering my application.<br>[Your name]</p>
    `,
  },
  {
    id: "letter", label: "Personal note", imageUrl: "/letter.svg",
    initialContent: `
      <h1>A note to [name]</h1><p>I wanted to share [news, thanks, or an idea].</p>
      <p>Here's the part that stayed with me: [your story].</p>
      <p>I'd love to hear what you think when you have time.</p>
      <p>Warmly,<br>[Your name]</p>
    `,
  },
];
