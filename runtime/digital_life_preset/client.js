window.__ModuleLoader__.load({id:'@local/dsh-digital-life-preset',factory:() => {
  const preset = 'persona';
  const panel = 'persona';
  function apply(ctx) {
    ctx.effect(() => {
      let active = true;
      let revision = 0;
      let lastDefault;
      let lastSeat;
      const enter = () => {
        if (!active) return;
        // The existing workspace plugin owns this panel and its single Host connection.
        if (!ctx.slots.entries('main').some(entry => entry.options.key === panel))
          throw new Error('Persona resident workspace is unavailable');
        ctx.layout.selectPanel(panel);
      };
      const inspectSeat = (navigation = false) => {
        const seat = Object.values(ctx.sessions.list.getSnapshot().byId)
          .find(session => (session.retainedBy.mainView ?? 0) > 0);
        const key = seat ? `${seat.id}:${seat.projectionValues?.agentPreset ?? ''}` : undefined;
        if (key === lastSeat && !navigation) return;
        lastSeat = key;
        if (seat?.projectionValues?.agentPreset === preset
          || (lastDefault === preset && (!seat || seat.blank))) enter();
      };
      const refresh = async () => {
        const current = ++revision;
        const result = await ctx.remote.agentPresets.list();
        if (!active || current !== revision || !result.ok) return;
        const selected = result.value.presets.find(row => row.isDefault)?.id;
        if (selected === lastDefault) return;
        lastDefault = selected;
        if (selected === preset) enter();
      };
      const disposers = [
        ctx.sessions.list.subscribe(inspectSeat),
        ctx.layout.panelInfo.subscribe(() => {
          if (ctx.layout.panelInfo.getSnapshot().activePanelId === null)
            void Promise.resolve().then(() => {if (active) inspectSeat(true);});
        }),
        ctx.remote.$on('settings/document-updated', ns => {
          if (ns === 'agent-preset-registry') void refresh();
        }),
        ctx.on('connection/reset', () => {lastDefault=undefined;void refresh();}),
      ];
      // Wait one microtask for the resident panel registration during initial client boot.
      void Promise.resolve().then(() => {if(active){inspectSeat();void refresh();}});
      return () => {active=false;revision++;for(const dispose of disposers)dispose();};
    }, 'Persona preset enters resident workspace');
  }
  return {inject:['layout','sessions','remote','remote.agentPresets','slots'],apply};
}});
