import { create } from 'zustand'

interface SetupState {
  /** True while the setup card is shown because the user asked for it again. */
  open: boolean
  /** Set when the user closed the card this session, so first-run does not reopen it. */
  dismissed: boolean
  openSetup: () => void
  closeSetup: () => void
  dismissSetup: () => void
}

/** "Run setup again" lives in Settings but the card renders on Create. */
export const useSetupStore = create<SetupState>((set) => ({
  open: false,
  dismissed: false,
  openSetup: () => set({ open: true, dismissed: false }),
  closeSetup: () => set({ open: false, dismissed: true }),
  dismissSetup: () => set({ open: false, dismissed: true })
}))
