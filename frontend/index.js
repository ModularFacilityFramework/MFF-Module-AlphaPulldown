// Module entry point. mff-core's auto-loader (App_frontend/src/core/moduleLoader.js)
// finds this file and calls register(coreApi) once at app startup - see
// docs/MFF-Core_module-core-api.md for the full coreApi contract. This file is the ONLY place
// this module's frontend talks to core.
//
// registerDashboardTab + sidebarEntry: true, not registerMenuPage: this
// content belongs inside Dashboard's shared tab bar (docs/MFF-Core_module-ui-guide.md,
// "Where a module's content actually renders") - there's nothing about this
// module that needs a fundamentally different layout or a genuinely
// separate page, so registerMenuPage's standalone-page/own-route behavior
// isn't warranted here. sidebarEntry: true still gives a direct left-sidebar
// button - it just lands on Dashboard with this tab already selected,
// instead of a second route/component. position: land in a gap between
// core's own tabs (5/10/15) - an admin can override this per deployment via
// MODULE_ABCFOLD_DASHBOARD_POSITION in App_backend/.env without touching
// this file at all.
import ABCFoldTab from './components/ABCFoldTab';
import manifest from '../module.manifest.json';

export function register(coreApi) {
  coreApi.registerDashboardTab(manifest.id, {
    key: manifest.id,
    label: manifest.label,
    component: () => <ABCFoldTab coreApi={coreApi} />,
    position: 20,
    sidebarEntry: true
  });
}
