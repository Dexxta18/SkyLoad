import { Link } from 'react-router-dom'
import { Logo } from '../components/Logo'

export default function Terms() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
      <Link to="/">
        <Logo />
      </Link>
      <h1 className="mt-10 text-3xl font-semibold tracking-tight">Terms & acceptable use</h1>
      <div className="muted mt-6 space-y-4 text-[15px] leading-relaxed">
        <p>
          Skyload fetches files you ask for and saves them to cloud storage accounts you connect. You are responsible for what you download and store. Only download content you own or have
          permission to share, such as open-source software, public-domain media and Creative Commons works.
        </p>
        <p>Don't use the service to infringe copyright, distribute malware, or download anything illegal where you or the server are. Accounts used this way will be suspended.</p>
        <p>
          Downloads are deleted from our servers as soon as they reach your cloud, or when a job fails or is cancelled. Cloud access tokens are stored encrypted and are used only to carry out the
          jobs you start. You can disconnect an account at any time, which deletes its stored credentials.
        </p>
        <p>The service is provided as is, without uptime or speed guarantees. Torrents depend on other people seeding them, so some may be slow or never finish.</p>
        <p>To report content or abuse, contact the operator of this site.</p>
      </div>
    </div>
  )
}
