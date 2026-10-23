#pragma once

#include <functional>
#include <string>
#include <utility>
#include <vector>

namespace esphome::panel_mqtt {

/** Keeps suffix-based MQTT subscriptions active under bootstrap and the assigned node name. */
class DynamicTopicAliasRegistry {
 public:
  using PrefixCallback = std::function<void(const std::string &)>;

  struct Subscription {
    PrefixCallback subscribe;
    PrefixCallback unsubscribe;
  };

  /** Adds a callback pair that can subscribe and unsubscribe a component's topic suffix. */
  static void register_subscription(PrefixCallback subscribe, PrefixCallback unsubscribe) {
    subscriptions_().push_back({std::move(subscribe), std::move(unsubscribe)});
    if (!active_alias_().empty()) subscriptions_().back().subscribe(active_alias_());
  }

  /** Moves registered subscriptions to the new operational alias while preserving bootstrap topics. */
  static void set_alias(const std::string &alias) {
    if (alias == active_alias_()) return;
    if (!active_alias_().empty()) {
      for (const auto &subscription : subscriptions_()) subscription.unsubscribe(active_alias_());
    }
    active_alias_() = alias;
    if (!active_alias_().empty()) {
      for (const auto &subscription : subscriptions_()) subscription.subscribe(active_alias_());
    }
  }

 private:
  static std::vector<Subscription> &subscriptions_() {
    static std::vector<Subscription> subscriptions;
    return subscriptions;
  }

  static std::string &active_alias_() {
    static std::string alias;
    return alias;
  }
};

}  // namespace esphome::panel_mqtt
